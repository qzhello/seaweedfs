// Package api wires the HTTP REST surface used by the Next.js console.
package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
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
	PG         *store.PG
	CH         *store.CH
	Sw         *seaweed.Client
	Exec       *executor.Executor
	Sched      *scheduler.Scheduler
	AI         ai.Provider
	AIResolver *ai.Resolver
	Snapshot   *runtime.Snapshot
	Resolver   *auth.Resolver
	Caps       *auth.CapsLoader
	Gate       *health.Gate
	Alerts     *alerter.Dispatcher
	Guard      *safety.Guard
	Skills     *skill.Registry
	Analytics  *analytics.Runner
	AIReview   *aireview.Service
	Pressure   *pressure.Snapshot
	Crypto     *crypto.AESGCM
	DevAuth    bool // allow X-User shortcut; true only for local dev
	Log        *zap.Logger
	// OpsRuns is the in-memory registry of interactive template
	// executions awaiting operator approval. One per process; the
	// SSE runner registers a run on POST and the approve/cancel
	// handlers look it up by id. Always non-nil after Router().
	OpsRuns *opsRunRegistry
	// Drains tracks live drain jobs (volumeServer.leave wrapped in a
	// durable record). Always non-nil after Router(). The startup
	// cleanup (ResetStaleDrains) runs from NewDrainController.
	Drains *drainController
}

func Router(d Deps) *gin.Engine {
	// Initialize stateful per-process resources that the existing
	// callers didn't fill in for us. Doing it here keeps cmd/controller
	// boot code simple and ensures every handler closure that captures
	// `d` below sees a non-nil registry.
	if d.OpsRuns == nil {
		d.OpsRuns = newOpsRunRegistry()
	}
	// Drain controller initialises with a startup reaper that flips
	// any leftover running/verifying rows to failed. Logged on
	// failure but never fatal — handlers degrade to NotFound if the
	// table is missing for some reason.
	if d.Drains == nil {
		if dc, err := NewDrainController(context.Background(), d.PG); err == nil {
			d.Drains = dc
		} else {
			d.Log.Sugar().Errorf("drain controller init failed: %v", err)
			d.Drains = &drainController{hub: newDrainHub(), cancels: map[uuid.UUID]context.CancelFunc{}}
		}
	}

	r := gin.New()
	r.Use(gin.Recovery(), zapMiddleware(d.Log), SecurityHeaders(), langMiddleware(d.Snapshot), commandAuditMiddleware())

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
		AllowHeaders:     []string{"Authorization", "Content-Type", "X-Token", "X-User", "X-Tier-Lang"},
		ExposeHeaders:    []string{"X-Trace-Id", "X-Slow-Query", "X-Executed-Command"},
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

	// /auth/login is the one v1 endpoint that must NOT require auth — it
	// trades credentials for a token. It still gets rate-limited (4 rps
	// per IP) so brute-force is annoying without locking real users out.
	publicAuth := r.Group("/api/v1/auth", RateLimit(4, 8))
	publicAuth.POST("/login", authLogin(d))

	v1 := r.Group("/api/v1",
		auth.Middleware(d.Resolver, d.DevAuth),
		RateLimit(20, 40), // 20 rps sustained, 40 burst per principal
		// Attaches an ai.UsageRecorder to the request context so every
		// downstream Chat/JSONChat call gets per-token-row persistence
		// without per-handler boilerplate.
		aiUsageRecorderMiddleware(d),
	)
	admin := v1.Group("", auth.RequireRole(auth.RoleAdmin), RateLimit(5, 10))
	{
		// --- Auth + capabilities (022) ---
		// /auth/me lets the frontend boot-strap caps without an extra
		// fetch per page; /permissions is admin-only edit surface.
		v1.GET("/auth/me", authMe(d))
		v1.POST("/auth/password", authChangePassword(d))
		v1.GET("/permissions", auth.RequireCap(d.Caps, "permissions.write"), listPermissions(d))
		v1.PUT("/permissions/:role", auth.RequireCap(d.Caps, "permissions.write"), setRolePermissions(d))

		// User management — read is broad (operator/viewer/auditor can
		// see who's on the platform); writes are admin-only via the
		// wildcard cap. Token reveal endpoints return plaintext exactly
		// once.
		v1.GET("/users", auth.RequireCap(d.Caps, "users.read"), listUsers(d))
		v1.POST("/users", auth.RequireCap(d.Caps, "users.write"), createUser(d))
		v1.PATCH("/users/:id", auth.RequireCap(d.Caps, "users.write"), updateUser(d))
		v1.POST("/users/:id/rotate-token", auth.RequireCap(d.Caps, "users.write"), rotateUserToken(d))
		v1.POST("/users/:id/reset-password", auth.RequireCap(d.Caps, "users.write"), resetUserPassword(d))
		v1.DELETE("/users/:id", auth.RequireCap(d.Caps, "users.write"), deleteUser(d))

		v1.GET("/volumes", listVolumes(d))
		v1.GET("/volumes/heatmap", heatmap(d))

		// Temperature dashboard — collection-level hot/cold breakdown
		// plus per-volume drilldown. Read-only against ClickHouse.
		v1.GET("/temperature/collections",
			auth.RequireCap(d.Caps, "volume.read"), temperatureCollections(d))
		v1.GET("/temperature/volumes",
			auth.RequireCap(d.Caps, "volume.read"), temperatureVolumes(d))

		// Costs dashboard — pricing CRUD + per-cluster cost calculator
		// + history snapshots + AI migration planner.
		v1.GET("/pricing",
			auth.RequireCap(d.Caps, "cost.read"), listPricing(d))
		v1.PUT("/pricing",
			auth.RequireCap(d.Caps, "cost.write"), upsertPricing(d))
		v1.DELETE("/pricing/:id",
			auth.RequireCap(d.Caps, "cost.write"), deletePricing(d))
		v1.GET("/costs/current",
			auth.RequireCap(d.Caps, "cost.read"), getCurrentCosts(d))
		v1.POST("/costs/snapshot",
			auth.RequireCap(d.Caps, "cost.write"), snapshotCosts(d))
		v1.GET("/costs/history",
			auth.RequireCap(d.Caps, "cost.read"), getCostHistory(d))
		v1.GET("/costs/showback",
			auth.RequireCap(d.Caps, "cost.read"), getShowback(d))
		v1.POST("/costs/ai-plan",
			auth.RequireCap(d.Caps, "cost.write"), aiPlanMigrations(d))
		// Fleet cost overview — cross-cluster aggregation + linear
		// forecast. Pure arithmetic for the numbers; optional AI prose
		// when ?explain=true.
		v1.GET("/costs/fleet",
			auth.RequireCap(d.Caps, "cost.read"), fleetCostOverview(d))

		// Gateway telemetry — what the S3/Filer gateways will write
		// per request. Read-only surfaces for now; ingestion path is
		// the operator's job (writes happen directly to ClickHouse
		// from the gateway).
		v1.GET("/telemetry/buckets",
			auth.RequireCap(d.Caps, "volume.read"), telemetryByBucket(d))
		v1.GET("/telemetry/access-summary",
			auth.RequireCap(d.Caps, "volume.read"), telemetryAccessSummary(d))

		// --- Volume operations (022/Phase 2) ---
		// Each one is a higher-level wrapper around `weed shell` with
		// structured parsing + per-feature capability gate so admins
		// can hand them out individually.
		v1.POST("/clusters/:id/volume/balance/plan",
			auth.RequireCap(d.Caps, "volume.balance"), volumeBalancePlan(d))
		// Streaming variants. /plan/stream forces apply=false (read-only
		// in terms of mutation); /apply/stream forces apply=true. Same
		// cap for both — the shell still needs the cluster lock either
		// way unless the operator opts into -noLock.
		v1.POST("/clusters/:id/volume/balance/plan/stream",
			auth.RequireCap(d.Caps, "volume.balance"), forceApply(false, volumeBalanceStream(d)))
		v1.POST("/clusters/:id/volume/balance/apply/stream",
			auth.RequireCap(d.Caps, "volume.balance"), forceApply(true, volumeBalanceStream(d)))
		// AI balance advisor — analyses the per-server volume spread and
		// suggests whether/at what scope to balance. Read-only.
		v1.POST("/clusters/:id/volume/balance/ai-advice",
			auth.RequireCap(d.Caps, "volume.balance"), balanceAdvisor(d))
		v1.POST("/clusters/:id/volume/grow",
			auth.RequireCap(d.Caps, "volume.grow"), volumeGrow(d))
		v1.POST("/clusters/:id/volume/grow/stream",
			auth.RequireCap(d.Caps, "volume.grow"), volumeGrowStream(d))
		v1.POST("/clusters/:id/volume/delete-empty",
			auth.RequireCap(d.Caps, "volume.delete-empty"), volumeDeleteEmpty(d))

		// --- Replication fixer ---
		// Same dual-mode shape as ec.rebuild: /plan forces apply=false +
		// `volume.read` cap; /apply forces apply=true + the dedicated
		// `volume.fix-replication` cap and streams SSE.
		v1.POST("/clusters/:id/volume/fix-replication/plan",
			auth.RequireCap(d.Caps, "volume.read"), forceApply(false, volumeFixReplicationHandler(d)))
		v1.POST("/clusters/:id/volume/fix-replication/apply",
			auth.RequireCap(d.Caps, "volume.fix-replication"), forceApply(true, volumeFixReplicationHandler(d)))

		// --- EC dry-run plans (read state but acquire shell lock) ---
		// Both `/plan` routes force apply=false on the server so the
		// `volume.read` cap is sufficient. The `/apply` siblings stream
		// SSE and require the relevant EC mutating cap.
		v1.POST("/clusters/:id/ec/rebuild/plan",
			auth.RequireCap(d.Caps, "volume.read"), forceApply(false, ecRebuildPlan(d)))
		v1.POST("/clusters/:id/ec/rebuild/apply",
			auth.RequireCap(d.Caps, "volume.ec.rebuild"), forceApply(true, ecRebuildPlan(d)))
		v1.POST("/clusters/:id/ec/balance/plan",
			auth.RequireCap(d.Caps, "volume.read"), forceApply(false, ecBalancePlan(d)))
		v1.POST("/clusters/:id/ec/balance/apply",
			auth.RequireCap(d.Caps, "volume.ec.balance"), forceApply(true, ecBalancePlan(d)))
		// --- EC encode / decode (always mutating; dry-run isn't a thing) ---
		v1.POST("/clusters/:id/ec/encode",
			auth.RequireCap(d.Caps, "volume.ec.encode"), ecEncode(d))
		v1.POST("/clusters/:id/ec/decode",
			auth.RequireCap(d.Caps, "volume.ec.decode"), ecDecode(d))
		// SSE stream variants — same body shape, but stdout is pushed line
		// by line so the UI can render a live progress panel.
		v1.POST("/clusters/:id/ec/encode/stream",
			auth.RequireCap(d.Caps, "volume.ec.encode"), ecEncodeStream(d))
		v1.POST("/clusters/:id/ec/decode/stream",
			auth.RequireCap(d.Caps, "volume.ec.decode"), ecDecodeStream(d))
		// On-demand EC integrity scrub (read-only). Streams per-node
		// progress; the done event carries the broken-shard summary.
		v1.POST("/clusters/:id/ec/scrub",
			auth.RequireCap(d.Caps, "volume.read"), ecScrubStream(d))

		// --- Cluster operations (Phase 3) ---
		// Manual fleet-wide health probe: fan out a tiered reachability +
		// quorum + filer + replication check across all clusters. Read-only.
		v1.POST("/clusters/health-check",
			auth.RequireCap(d.Caps, "cluster.read"), fleetHealthCheck(d))
		v1.POST("/clusters/:id/check-disk",
			auth.RequireCap(d.Caps, "volume.check-disk"), clusterCheckDisk(d))
		v1.POST("/clusters/:id/replication",
			auth.RequireCap(d.Caps, "cluster.replication.configure"), clusterConfigureReplication(d))
		v1.GET("/clusters/:id/replication-health",
			auth.RequireCap(d.Caps, "volume.read"), replicationHealth(d))
		// Policy time machine — dry-run a policy against the current
		// cluster state and project matched bytes + cost savings.
		v1.POST("/policies/:id/simulate", policySimulate(d))

		v1.POST("/clusters/:id/volume-server/leave",
			auth.RequireCap(d.Caps, "cluster.volume-server.leave"), clusterVolumeServerLeave(d))
		v1.POST("/clusters/:id/volume-server/leave/stream",
			auth.RequireCap(d.Caps, "cluster.volume-server.leave"), clusterVolumeServerLeaveStream(d))

		// Persistent drain jobs. Same underlying command but recorded
		// in the database so operators can walk away and verify
		// completion from any page reload.
		v1.GET("/drains",
			auth.RequireCap(d.Caps, "cluster.volume-server.leave"), listDrains(d))
		v1.GET("/drains/:id",
			auth.RequireCap(d.Caps, "cluster.volume-server.leave"), getDrain(d))
		v1.GET("/drains/:id/stream",
			auth.RequireCap(d.Caps, "cluster.volume-server.leave"), streamDrain(d))
		v1.POST("/clusters/:id/drains",
			auth.RequireCap(d.Caps, "cluster.volume-server.leave"), createDrain(d))
		v1.POST("/drains/:id/cancel",
			auth.RequireCap(d.Caps, "cluster.volume-server.leave"), cancelDrain(d))

		// --- S3 (Phase 4) ---
		// GET /identities and /identities/rotation are SAFE to read with
		// just s3.read because s3ListIdentities now redacts secret keys
		// from the response. This lets operators/viewers see "who is
		// bound to which bucket" via the Bound access column without
		// granting them write access to IAM. Writes still gated on the
		// admin-only s3.configure cap.
		v1.GET("/clusters/:id/s3/identities",
			auth.RequireCap(d.Caps, "s3.read"), s3ListIdentities(d))
		v1.PUT("/clusters/:id/s3/identities",
			auth.RequireCap(d.Caps, "s3.configure"), s3UpsertIdentity(d))
		v1.DELETE("/clusters/:id/s3/identities/:user",
			auth.RequireCap(d.Caps, "s3.configure"), s3DeleteIdentity(d))
		// Per-identity secret reveal — admin-only because it exposes SK.
		v1.GET("/clusters/:id/s3/identities/:user/secret",
			auth.RequireCap(d.Caps, "s3.configure"), s3GetIdentitySecret(d))
		v1.GET("/clusters/:id/s3/identities/rotation",
			auth.RequireCap(d.Caps, "s3.read"), s3IdentityRotation(d))
		v1.POST("/clusters/:id/s3/bucket/delete",
			auth.RequireCap(d.Caps, "s3.bucket.delete"), s3BucketDelete(d))
		v1.POST("/clusters/:id/s3/bucket/owner",
			auth.RequireCap(d.Caps, "s3.bucket.owner"), s3BucketOwner(d))
		v1.POST("/clusters/:id/s3/bucket/quota",
			auth.RequireCap(d.Caps, "s3.bucket.quota"), s3BucketQuota(d))
		v1.POST("/clusters/:id/s3/bucket/quota-enforce",
			auth.RequireCap(d.Caps, "s3.bucket.quota.enforce"), s3BucketQuotaEnforce(d))
		v1.POST("/clusters/:id/s3/circuit-breaker",
			auth.RequireCap(d.Caps, "s3.circuit-breaker"), s3CircuitBreaker(d))
		v1.POST("/clusters/:id/s3/clean-uploads",
			auth.RequireCap(d.Caps, "s3.clean-uploads"), s3CleanUploads(d))
		// Structured multipart upload introspection. Walks the filer
		// directly so the AI tool and the Clean Uploads UI can see
		// per-upload rows (bucket, key, upload_id, age, size) instead
		// of the raw shell output from s3.clean.uploads.
		v1.GET("/clusters/:id/s3/multipart-uploads",
			auth.RequireCap(d.Caps, "s3.clean-uploads"), s3ListMultipartUploads(d))
		v1.DELETE("/clusters/:id/s3/multipart-uploads/:bucket/:upload_id",
			auth.RequireCap(d.Caps, "s3.clean-uploads"), s3AbortMultipartUpload(d))
		v1.POST("/clusters/:id/s3/nl-policy",
			auth.RequireCap(d.Caps, "s3.configure"), s3NLPolicy(d))
		// S3 Tables (Iceberg) — table-bucket lifecycle + resource policy.
		// Separate cap pair from regular s3.bucket.* so admins can grant
		// table access independently.
		v1.GET("/clusters/:id/s3/tables/buckets",
			auth.RequireCap(d.Caps, "s3.tables.read"), s3TableBucketsList(d))
		v1.GET("/clusters/:id/s3/tables/buckets/:name",
			auth.RequireCap(d.Caps, "s3.tables.read"), s3TableBucketGet(d))
		v1.POST("/clusters/:id/s3/tables/buckets",
			auth.RequireCap(d.Caps, "s3.tables.write"), s3TableBucketCreate(d))
		v1.DELETE("/clusters/:id/s3/tables/buckets/:name",
			auth.RequireCap(d.Caps, "s3.tables.write"), s3TableBucketDelete(d))
		v1.GET("/clusters/:id/s3/tables/buckets/:name/policy",
			auth.RequireCap(d.Caps, "s3.tables.read"), s3TableBucketGetPolicy(d))
		v1.PUT("/clusters/:id/s3/tables/buckets/:name/policy",
			auth.RequireCap(d.Caps, "s3.tables.write"), s3TableBucketPutPolicy(d))
		v1.DELETE("/clusters/:id/s3/tables/buckets/:name/policy",
			auth.RequireCap(d.Caps, "s3.tables.write"), s3TableBucketDeletePolicy(d))

		// Namespaces inside a bucket.
		v1.GET("/clusters/:id/s3/tables/namespaces",
			auth.RequireCap(d.Caps, "s3.tables.read"), s3TableNamespacesList(d))
		v1.GET("/clusters/:id/s3/tables/namespaces/:name",
			auth.RequireCap(d.Caps, "s3.tables.read"), s3TableNamespaceGet(d))
		v1.POST("/clusters/:id/s3/tables/namespaces",
			auth.RequireCap(d.Caps, "s3.tables.write"), s3TableNamespaceCreate(d))
		v1.DELETE("/clusters/:id/s3/tables/namespaces/:name",
			auth.RequireCap(d.Caps, "s3.tables.write"), s3TableNamespaceDelete(d))

		// Tables inside a (bucket, namespace).
		v1.GET("/clusters/:id/s3/tables/tables",
			auth.RequireCap(d.Caps, "s3.tables.read"), s3TablesList(d))
		v1.GET("/clusters/:id/s3/tables/tables/:name",
			auth.RequireCap(d.Caps, "s3.tables.read"), s3TableGet(d))
		v1.POST("/clusters/:id/s3/tables/tables",
			auth.RequireCap(d.Caps, "s3.tables.write"), s3TableCreate(d))
		v1.DELETE("/clusters/:id/s3/tables/tables/:name",
			auth.RequireCap(d.Caps, "s3.tables.write"), s3TableDelete(d))
		v1.GET("/clusters/:id/s3/tables/tables/:name/policy",
			auth.RequireCap(d.Caps, "s3.tables.read"), s3TableGetPolicy(d))
		v1.PUT("/clusters/:id/s3/tables/tables/:name/policy",
			auth.RequireCap(d.Caps, "s3.tables.write"), s3TablePutPolicy(d))
		v1.DELETE("/clusters/:id/s3/tables/tables/:name/policy",
			auth.RequireCap(d.Caps, "s3.tables.write"), s3TableDeletePolicy(d))

		// Tags — one endpoint set across bucket/namespace/table scope.
		v1.GET("/clusters/:id/s3/tables/tags",
			auth.RequireCap(d.Caps, "s3.tables.read"), s3TableTagsList(d))
		v1.PUT("/clusters/:id/s3/tables/tags",
			auth.RequireCap(d.Caps, "s3.tables.write"), s3TableTagsPut(d))
		v1.DELETE("/clusters/:id/s3/tables/tags",
			auth.RequireCap(d.Caps, "s3.tables.write"), s3TableTagsDelete(d))
		v1.GET("/volumes/:id/features", volumeFeatures(d))
		v1.GET("/volumes/:id/features/trend", volumeFeatureTrend(d))
		v1.GET("/volumes/features/trend/bulk", volumeFeatureTrendBulk(d))
		v1.GET("/volumes/:id/score", scoreOne(d))

		v1.GET("/policies", listPolicies(d))
		v1.GET("/policies/roi", policyROI(d))
		admin.PUT("/policies", upsertPolicy(d))
		// AI migration advisor — analyses volume temperature and
		// proposes policy drafts. Read-only: returns drafts, never
		// writes. Routed under /ai/ to avoid the /policies/:id param.
		v1.POST("/ai/policy-recommendations", policyAdvisor(d))

		// Lightweight live counters for nav badges. Public to any
		// authed user; doesn't expose row contents.
		v1.GET("/counts", counts(d))
		v1.GET("/tasks", listTasks(d))
		// Fleet ops rollup — per-cluster queue depth, stuck-task
		// hotspots, action failure rate, daily throughput. Pure SQL,
		// no AI. Gated by cluster.read since it's a passive view.
		v1.GET("/ops/fleet", opsFleetOverview(d))
		// Create a task from an AI migration proposal. Requires
		// cost.write (the same gate that lets the operator generate
		// proposals); the admin group gate is reused so the existing
		// approval pipeline still runs before any shell executes.
		admin.POST("/tasks/from-proposal",
			auth.RequireCap(d.Caps, "cost.write"), createTaskFromProposal(d))
		admin.POST("/tasks/:id/approve", approveTask(d))
		admin.POST("/tasks/:id/cancel", cancelTask(d))
		admin.POST("/tasks/:id/run", runTask(d))
		admin.POST("/tasks/:id/stop", stopTask(d))
		admin.POST("/tasks/:id/retry", retryTask(d))

		v1.GET("/clusters/pressure", listClusterPressure(d))
		v1.GET("/clusters/score/history",
			auth.RequireCap(d.Caps, "volume.read"), scoreHistory(d))

		// Capacity incidents — the auto-pause closed loop. analyze/resolve
		// are state-changing (AI spend / lifts the tiering hold) → admin.
		v1.GET("/incidents", listCapacityIncidents(d))
		v1.GET("/incidents/:id", getCapacityIncident(d))
		admin.POST("/incidents/:id/analyze", analyzeCapacityIncident(d))
		admin.POST("/incidents/:id/resolve", resolveCapacityIncident(d))

		// Capacity forecast — proactive "full in N days" per cluster.
		v1.GET("/capacity/forecast", capacityForecastAll(d))

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
		// S3 policy counterfactual learning — record operator decisions
		// on NL → IAM proposals so the learning panel can show acceptance
		// rate per-risk over time. Decide is paired with the proposal
		// emitted by POST /clusters/:id/s3/nl-policy.
		v1.POST("/ai/s3-proposals/:id/decide",
			auth.RequireCap(d.Caps, "s3.configure"), s3NLPolicyDecide(d))
		v1.GET("/ai/s3-learning", s3LearningSummary(d))
		// Circuit-breaker limit AI advisor — emit, decide, learning summary.
		// Same lifecycle as the NL → IAM flow but for s3.circuitBreaker.
		v1.POST("/clusters/:id/s3/recommend-limits",
			auth.RequireCap(d.Caps, "s3.circuit-breaker"), s3RecommendLimits(d))
		v1.POST("/ai/s3-limit-proposals/:id/decide",
			auth.RequireCap(d.Caps, "s3.circuit-breaker"), s3LimitProposalDecide(d))
		v1.GET("/ai/s3-limit-learning", s3LimitLearningSummary(d))
		// Bucket-level cost AI plan — per-bucket lifecycle suggestions.
		// Cost-write gate to match /costs/ai-plan; both are advisory
		// until the operator explicitly applies.
		v1.POST("/clusters/:id/buckets/cost-plan",
			auth.RequireCap(d.Caps, "cost.write"), bucketCostPlan(d))
		v1.POST("/ai/bucket-cost-proposals/:id/decide",
			auth.RequireCap(d.Caps, "cost.write"), bucketCostPlanDecide(d))
		v1.GET("/ai/bucket-cost-learning", bucketCostLearningSummary(d))
		// Alert triage — read-only AI summariser over the last N hours
		// of alert_events. No proposal, no auto-silence.
		v1.POST("/alerts/triage", alertTriage(d))

		// --- AI floating assistant (024) ---
		v1.GET("/ai/assistant/chats",
			auth.RequireCap(d.Caps, "ai.assistant"), listAssistantChats(d))
		v1.POST("/ai/assistant/chats",
			auth.RequireCap(d.Caps, "ai.assistant"), createAssistantChat(d))
		v1.PUT("/ai/assistant/chats/:id",
			auth.RequireCap(d.Caps, "ai.assistant"), renameAssistantChat(d))
		v1.DELETE("/ai/assistant/chats/:id",
			auth.RequireCap(d.Caps, "ai.assistant"), deleteAssistantChat(d))
		v1.GET("/ai/assistant/chats/:id/messages",
			auth.RequireCap(d.Caps, "ai.assistant"), listAssistantMessages(d))
		v1.POST("/ai/assistant/chats/:id/messages",
			auth.RequireCap(d.Caps, "ai.assistant"), postAssistantMessage(d))
		// Streaming variant with tool calling. Same cap as the
		// blocking endpoint; the transport is just SSE + an agentic
		// loop that auto-executes the read-only tools registered in
		// assistant_tools.go.
		v1.POST("/ai/assistant/chats/:id/messages/stream",
			auth.RequireCap(d.Caps, "ai.assistant"), postAssistantMessageStream(d))

		v1.GET("/ai/providers", listAIProvidersV2(d))
		admin.PUT("/ai/providers", upsertAIProvider(d))

		// --- AI tool policies (029) ---
		// Operator-visible authorization layer for the assistant's
		// tool catalogue. Read with ai.assistant cap (anyone using
		// the assistant deserves to see what it can do); writes
		// require admin so toggling can't be self-served.
		v1.GET("/ai/tool-policies",
			auth.RequireCap(d.Caps, "ai.assistant"), listAIToolPoliciesHandler(d))
		admin.PUT("/ai/tool-policies", upsertAIToolPolicyHandler(d))
		admin.DELETE("/ai/providers/:id", deleteAIProvider(d))
		admin.POST("/ai/providers/:id/test", testAIProvider(d))
		v1.POST("/ai/test", testAI(d))
		// Admin-only token usage rollups — feeds the AI usage panel.
		admin.GET("/ai/usage", getAIUsage(d))
		// Model pricing: read open to any logged-in operator so the
		// usage panel can decorate; mutations restricted to admin.
		v1.GET("/ai/pricing", listAIModelPricing(d))
		admin.PUT("/ai/pricing", upsertAIModelPricing(d))
		admin.DELETE("/ai/pricing", deleteAIModelPricing(d))
		// AI budgets: monthly spend caps + tier alerts. Read open;
		// mutations admin-only; evaluate fires alerts so it's
		// admin-only too (cron job runs with admin credentials).
		v1.GET("/ai/budgets", listAIBudgets(d))
		admin.PUT("/ai/budgets", upsertAIBudget(d))
		admin.DELETE("/ai/budgets/:id", deleteAIBudget(d))
		admin.POST("/ai/budgets/evaluate", evaluateAIBudgets(d))

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
		// AI risk advisor for a single about-to-run step. Pure
		// advisory, never blocks. Called automatically when the
		// template has ai_precheck=true, or manually from the
		// approval card's "Ask AI" button.
		admin.POST("/ops/templates/precheck-step", precheckOpsStep(d))
		admin.GET("/clusters/:id/ops/templates/:tid/run", runOpsTemplateBridge(d))
		// Interactive runner: pauses on confirm_before steps and on
		// AI variable inference proposals. Cancellable mid-flow via
		// /ops-runs/:run_id/cancel. See ops_template_run_interactive.go.
		admin.GET("/clusters/:id/ops/templates/:tid/run-interactive", runOpsTemplateInteractive(d))
		admin.POST("/ops-runs/:run_id/approve", approveOpsRun(d))
		admin.POST("/ops-runs/:run_id/cancel", cancelOpsRun(d))

		// Resource listings used by per-resource pages.
		v1.GET("/clusters/:id/buckets", listBuckets(d))
		// Bucket governance — controller-side owner + data-lifecycle.
		admin.PUT("/clusters/:id/buckets/:bucket/governance", upsertBucketGovernance(d))
		admin.POST("/clusters/:id/buckets/:bucket/lifecycle-scan", scanBucketLifecycle(d))
		v1.GET("/lifecycle/buckets", listGovernedBuckets(d))
		v1.GET("/clusters/:id/collections", listCollections(d))
		// Drilldown detail pages. Both reuse the existing volume-list cache
		// + the shared `volume.read` cap so they don't introduce new
		// permissions; the path params carry the collection name and
		// volume-server address respectively (URL-encoded).
		v1.GET("/clusters/:id/collections/:name",
			auth.RequireCap(d.Caps, "volume.read"), clusterCollectionDetail(d))
		v1.GET("/clusters/:id/volume-servers/:addr",
			auth.RequireCap(d.Caps, "volume.read"), clusterVolumeServerDetail(d))

		// --- Cluster master/raft diagnostics ---
		// `/masters` aggregates every reachable master's view of the
		// raft quorum and the admin-lock metric so operators can see
		// peer-set divergence at a glance. `/masters/lock-probe` leases
		// and immediately releases the admin lock to expose the holder
		// without granting any broader write capability.
		v1.GET("/clusters/:id/masters",
			auth.RequireCap(d.Caps, "cluster.read"), clusterMasters(d))
		v1.POST("/clusters/:id/masters/lock-probe",
			auth.RequireCap(d.Caps, "cluster.lock.probe"), clusterMasterLockProbe(d))
		// Graceful raft leadership transfer (maintenance prep). Emergency-
		// stop gated only — must work during change/maintenance windows.
		v1.POST("/clusters/:id/masters/transfer-leader",
			auth.RequireCap(d.Caps, "cluster.raft.transfer"), clusterRaftTransferLeader(d))

		// --- Filer / volume / EC drilldown ---
		// `/filers` lists filers from the master + parallel HTTP `/status`
		// probe so the UI can show reachability inline. `/volumes/:vid`
		// turns the volume-list cache into a single-volume detail page
		// (all replicas, placement, EC shards). `/ec-shards` returns the
		// 14-shard layout per EC volume so missing shards are obvious.
		v1.GET("/clusters/:id/filers",
			auth.RequireCap(d.Caps, "cluster.read"), clusterFilers(d))
		v1.GET("/clusters/:id/volumes/:vid",
			auth.RequireCap(d.Caps, "volume.read"), clusterVolumeDetail(d))
		v1.GET("/clusters/:id/ec-shards",
			auth.RequireCap(d.Caps, "volume.read"), clusterECShards(d))
		v1.GET("/clusters/:id/ec-volumes/:vid",
			auth.RequireCap(d.Caps, "volume.read"), clusterECVolumeDetail(d))

		// --- File Browser ---
		// Read endpoints (list + download) use `file.read`; mutating ones
		// (upload, mkdir, delete) use `file.write`. The handlers validate
		// that the `?filer=` arg is one of the cluster's registered filers
		// to prevent SSRF — without that check the proxy would happily
		// forward to any internal address.
		v1.GET("/clusters/:id/files",
			auth.RequireCap(d.Caps, "file.read"), clusterFilesList(d))
		v1.GET("/clusters/:id/files/download",
			auth.RequireCap(d.Caps, "file.read"), clusterFilesDownload(d))
		v1.POST("/clusters/:id/files/upload",
			auth.RequireCap(d.Caps, "file.write"), clusterFilesUpload(d))
		v1.POST("/clusters/:id/files/mkdir",
			auth.RequireCap(d.Caps, "file.write"), clusterFilesMkdir(d))
		v1.DELETE("/clusters/:id/files",
			auth.RequireCap(d.Caps, "file.write"), clusterFilesDelete(d))

		// Path-scoped migration wizard — walks the filer under a path
		// and (a) returns an impact preview, (b) asks the AI to draft
		// migration proposals scoped to that path's collections.
		v1.POST("/clusters/:id/path-migrate/preview",
			auth.RequireCap(d.Caps, "file.read"), pathMigratePreview(d))
		v1.POST("/clusters/:id/path-migrate/ai-plan",
			auth.RequireCap(d.Caps, "cost.write"), pathMigrateAIPlan(d))

		v1.GET("/clusters/:id/topology", clusterTopology(d))
		v1.GET("/clusters/:id/disk", clusterDiskUsage(d))
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
		// Bulk-ack ("ignore") alert events. Available to any authed
		// caller (not admin-only) — it's a per-operator silencing
		// gesture, not a configuration change. Audited.
		v1.POST("/alerts/events/ack", ackAlertEvents(d))
		admin.POST("/alerts/test", fireTestAlert(d))

		// Alert templates: reusable subject/body templates used by
		// per-flow alert routing. List is read-only (no cap); mutating
		// endpoints require admin.
		v1.GET("/alerts/templates", listAlertTemplates(d))
		v1.GET("/alerts/templates/:id", getAlertTemplate(d))
		admin.PUT("/alerts/templates", upsertAlertTemplate(d))
		admin.DELETE("/alerts/templates/:id", deleteAlertTemplate(d))
		admin.POST("/alerts/templates/preview", previewAlertTemplate(d))

		// Analyzer scripts: deterministic Python post-processors for
		// shell-command output. List/get/run are read-only caps so
		// templates can invoke them; create/edit/delete are admin.
		v1.GET("/analyzer/scripts", listAnalyzerScripts(d))
		v1.GET("/analyzer/scripts/:id", getAnalyzerScript(d))
		v1.POST("/analyzer/run", runAnalyzerScript(d))
		v1.GET("/analyzer/scripts/:id/runs", recentAnalyzerRuns(d))
		v1.GET("/analyzer/scripts/:id/versions", listAnalyzerScriptVersions(d))
		v1.GET("/analyzer/scripts/:id/versions/:version", getAnalyzerScriptVersion(d))
		admin.PUT("/analyzer/scripts", upsertAnalyzerScript(d))
		admin.DELETE("/analyzer/scripts/:id", deleteAnalyzerScript(d))
		admin.POST("/analyzer/scripts/:id/optimize", optimizeAnalyzerScript(d))
		admin.POST("/analyzer/scripts/:id/revert/:version", revertAnalyzerScript(d))

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
		// Section-scoped AI helper. Operator passes the partial draft +
		// one section name ("steps", "rollback", "postchecks",
		// "preconditions", "risk"); AI returns just that section,
		// validated against the skill schema before reply.
		admin.POST("/skills/wizard-suggest", skillWizardSuggest(d))

		v1.GET("/audit", listAudit(d))
		v1.GET("/audit/facets", auditFacets(d))
		// AI summary — narrative over the same audit slice. Read-only,
		// no proposal, no persistence; just synthesis.
		v1.POST("/audit/summary", auditSummarize(d))
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
