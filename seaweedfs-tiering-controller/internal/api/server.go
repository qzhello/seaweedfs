// Package api wires the HTTP REST surface used by the Next.js console.
package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/ai"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/aireview"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/alerter"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/analytics"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/crypto"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/executor"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/health"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/pressure"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/runtime"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/safety"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/scheduler"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/seaweed"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/skill"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

type Deps struct {
	PG        *store.PG
	CH        *store.CH
	Sw        *seaweed.Client
	Exec      *executor.Executor
	Sched     *scheduler.Scheduler
	AI        ai.Provider
	Snapshot  *runtime.Snapshot
	Resolver  *auth.Resolver
	Gate      *health.Gate
	Alerts    *alerter.Dispatcher
	Guard     *safety.Guard
	Skills    *skill.Registry
	Analytics *analytics.Runner
	AIReview  *aireview.Service
	Pressure  *pressure.Snapshot
	Crypto    *crypto.AESGCM
	DevAuth   bool // allow X-User shortcut; true only for local dev
	Log       *zap.Logger
}

func Router(d Deps) *gin.Engine {
	r := gin.New()
	r.Use(gin.Recovery(), zapMiddleware(d.Log), SecurityHeaders())

	// CORS origins read from runtime snapshot if available; default to dev origins.
	origins := []string{"http://localhost:3000", "http://127.0.0.1:3000"}
	if d.Snapshot != nil {
		if csv := d.Snapshot.String("server.cors_origins", ""); csv != "" {
			origins = splitCSV(csv)
		}
	}
	r.Use(cors.New(cors.Config{
		AllowOrigins:     origins,
		AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Authorization", "Content-Type", "X-Token", "X-User"},
		ExposeHeaders:    []string{"X-Trace-Id", "X-Slow-Query"},
		AllowCredentials: true,
		MaxAge:           12 * time.Hour,
	}))

	r.GET("/healthz", func(c *gin.Context) {
		// `controller.role` is a Sprint 5 placeholder — single-instance today,
		// leader/standby/shadow when HA lands. Returning it here lets ops
		// scripts and the Web UI key off it without further wiring later.
		role := "single"
		if d.Snapshot != nil {
			role = d.Snapshot.String("controller.role", "single")
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "role": role})
	})
	r.GET("/readyz", func(c *gin.Context) {
		// Cheap dependency probe.
		ctx := c.Request.Context()
		if err := d.PG.Pool.Ping(ctx); err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"pg": "down"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	v1 := r.Group("/api/v1",
		auth.Middleware(d.Resolver, d.DevAuth),
		RateLimit(20, 40), // 20 rps sustained, 40 burst per principal
	)
	admin := v1.Group("", auth.RequireRole(auth.RoleAdmin), RateLimit(5, 10))
	{
		v1.GET("/volumes", listVolumes(d))
		v1.GET("/volumes/heatmap", heatmap(d))
		v1.GET("/volumes/:id/features", volumeFeatures(d))
		v1.GET("/volumes/:id/score", scoreOne(d))

		v1.GET("/policies", listPolicies(d))
		admin.PUT("/policies", upsertPolicy(d))

		v1.GET("/tasks", listTasks(d))
		admin.POST("/tasks/:id/approve", approveTask(d))
		admin.POST("/tasks/:id/cancel", cancelTask(d))
		admin.POST("/tasks/:id/run", runTask(d))
		admin.POST("/tasks/:id/stop", stopTask(d))
		admin.POST("/tasks/:id/retry", retryTask(d))

		v1.GET("/clusters/pressure", listClusterPressure(d))

		v1.GET("/tasks/:id", getTask(d))
		v1.GET("/tasks/:id/autonomy", taskAutonomy(d))
		v1.GET("/tasks/:id/latest-execution", latestExecutionForTask(d))
		v1.GET("/executions/:id", getExecution(d))
		admin.POST("/executions/:id/rollback", rollbackExecution(d))
		admin.POST("/executions/:id/postmortem", runPostmortem(d))
		admin.POST("/executions/:id/apply-postmortem", applyPostmortemSuggestion(d))

		v1.GET("/tasks/:id/review", getTaskReview(d))
		admin.POST("/tasks/:id/review", runTaskReview(d))
		v1.GET("/ai/learning", learningSummary(d))

		v1.GET("/ai/providers", listAIProvidersV2(d))
		admin.PUT("/ai/providers", upsertAIProvider(d))
		admin.DELETE("/ai/providers/:id", deleteAIProvider(d))
		admin.POST("/ai/providers/:id/test", testAIProvider(d))
		v1.POST("/ai/test", testAI(d))

		admin.POST("/scheduler/score-now", scoreNow(d))

		v1.GET("/dashboard/summary", dashboardSummary(d))

		// --- Multi-cluster + tags + holidays + trends (002) ---
		v1.GET("/clusters", listClusters(d))
		admin.PUT("/clusters", upsertCluster(d))
		admin.DELETE("/clusters/:id", deleteCluster(d))
		admin.POST("/clusters/:id/shell", clusterShellExec(d))
		admin.GET("/clusters/:id/shell/stream", clusterShellStream(d))
		v1.GET("/clusters/:id/shell/help", clusterShellHelp(d))
		v1.GET("/clusters/:id/health", clusterHealth(d))
		v1.GET("/shell/catalog", shellCatalogList(d))

		// --- Ops templates (021) ---
		v1.GET("/ops/templates", listOpsTemplates(d))
		v1.GET("/ops/templates/:id", getOpsTemplate(d))
		admin.PUT("/ops/templates", upsertOpsTemplate(d))
		admin.DELETE("/ops/templates/:id", deleteOpsTemplate(d))
		admin.POST("/ops/templates/draft", draftOpsTemplate(d))
		admin.GET("/clusters/:id/ops/templates/:tid/run", runOpsTemplateBridge(d))

		// Resource listings used by per-resource pages.
		v1.GET("/clusters/:id/buckets", listBuckets(d))
		v1.GET("/clusters/:id/collections", listCollections(d))

		v1.GET("/clusters/:id/topology", clusterTopology(d))
		v1.GET("/clusters/:id/tags", listTags(d))
		admin.PUT("/clusters/:id/tags", upsertTag(d))
		admin.DELETE("/tags/:id", deleteTag(d))

		v1.GET("/holidays", listHolidays(d))
		v1.GET("/trend", trend(d))
		v1.GET("/trend/by-domain", trendByDomain(d))

		// --- Configuration center (003) ---
		v1.GET("/config", listConfig(d))
		admin.PUT("/config/:key", updateConfig(d))
		v1.GET("/config/:key/history", configHistory(d))
		admin.POST("/config/:key/rollback/:history_id", rollbackConfig(d))

		// --- Storage backends (004) ---
		v1.GET("/backends", listBackends(d))
		admin.PUT("/backends", upsertBackend(d))
		admin.DELETE("/backends/:id", deleteBackend(d))
		admin.POST("/backends/:id/test", testBackend(d))

		// --- Health monitoring (005) ---
		v1.GET("/monitor/targets", listMonitorTargets(d))
		admin.PUT("/monitor/targets", upsertMonitorTarget(d))
		admin.DELETE("/monitor/targets/:id", deleteMonitorTarget(d))
		v1.GET("/monitor/targets/:id/samples", healthSamples(d))
		v1.GET("/health/gate", healthGate(d))

		// --- Alerts (006) ---
		v1.GET("/alerts/channels", listAlertChannels(d))
		admin.PUT("/alerts/channels", upsertAlertChannel(d))
		admin.DELETE("/alerts/channels/:id", deleteAlertChannel(d))
		v1.GET("/alerts/rules", listAlertRules(d))
		admin.PUT("/alerts/rules", upsertAlertRule(d))
		admin.DELETE("/alerts/rules/:id", deleteAlertRule(d))
		v1.GET("/alerts/events", recentAlertEvents(d))
		admin.POST("/alerts/test", fireTestAlert(d))

		// --- Safety (007) ---
		v1.GET("/safety/status", safetyStatus(d))
		admin.POST("/safety/emergency-stop", emergencyStop(d))
		v1.GET("/safety/blocklist", listBlocklist(d))
		admin.PUT("/safety/blocklist", upsertBlocklist(d))
		admin.DELETE("/safety/blocklist/:id", deleteBlocklist(d))
		v1.GET("/safety/maintenance", listMaintenance(d))
		admin.PUT("/safety/maintenance", upsertMaintenance(d))
		admin.DELETE("/safety/maintenance/:id", deleteMaintenance(d))

		// --- Analytics: cyclical + cohort (CH 002) ---
		v1.GET("/volumes/:id/pattern", volumePattern(d))
		v1.GET("/cohort/baselines", cohortBaselines(d))
		v1.GET("/cohort/anomalies", cohortAnomalies(d))
		v1.GET("/cohort/breakdown", cohortBreakdown(d))
		admin.POST("/analytics/refresh", triggerAnalyticsPass(d))

		// --- Skills (009) ---
		v1.GET("/skills", listSkills(d))
		v1.GET("/skills/:key/history", getSkillHistory(d))
		admin.PUT("/skills", upsertSkill(d))
		admin.POST("/skills/:key/toggle", toggleSkill(d))
		admin.POST("/skills/validate", validateSkillDef(d))
		admin.POST("/skills/draft-from-text", draftSkillFromText(d))

		v1.GET("/audit", listAudit(d))
		v1.GET("/audit/facets", auditFacets(d))
	}
	return r
}

func zapMiddleware(log *zap.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()
		log.Info("http",
			zap.String("method", c.Request.Method),
			zap.String("path", c.FullPath()),
			zap.Int("status", c.Writer.Status()))
	}
}

func splitCSV(s string) []string {
	out := []string{}
	for _, p := range strings.Split(s, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
