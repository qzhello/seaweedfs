package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/ai"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/aireview"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/seaweed"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/validation"
)

// ---------------- Volumes ----------------

func listVolumes(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx := c.Request.Context()
		clusters, err := d.PG.ListClusters(ctx)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		// Optional ?cluster_id=<uuid>[,<uuid>] filter.
		var filter map[string]struct{}
		if raw := c.Query("cluster_id"); raw != "" {
			filter = map[string]struct{}{}
			for _, part := range strings.Split(raw, ",") {
				if id := strings.TrimSpace(part); id != "" {
					filter[id] = struct{}{}
				}
			}
		}
		type volWithCluster struct {
			seaweed.VolumeInfo
			ClusterID   string `json:"cluster_id"`
			ClusterName string `json:"cluster_name"`
		}
		type nodeWithCluster struct {
			seaweed.NodeDiskStats
			ClusterID   string `json:"cluster_id"`
			ClusterName string `json:"cluster_name"`
		}
		items := []volWithCluster{}
		nodes := []nodeWithCluster{}
		clusterErrors := []gin.H{}
		clustersOK := 0
		for _, cl := range clusters {
			if !cl.Enabled {
				continue
			}
			if filter != nil {
				if _, ok := filter[cl.ID.String()]; !ok {
					continue
				}
			}
			vols, ns, lvErr := fetchClusterVolumes(ctx, d.Sw, cl.MasterAddr, cl.WeedBinPath)
			if lvErr != nil {
				clusterErrors = append(clusterErrors, gin.H{
					"cluster": cl.Name, "master": cl.MasterAddr, "error": lvErr.Error(),
				})
				continue
			}
			clustersOK++
			for _, v := range vols {
				items = append(items, volWithCluster{
					VolumeInfo: v, ClusterID: cl.ID.String(), ClusterName: cl.Name,
				})
			}
			for _, n := range ns {
				nodes = append(nodes, nodeWithCluster{
					NodeDiskStats: n, ClusterID: cl.ID.String(), ClusterName: cl.Name,
				})
			}
		}
		c.JSON(http.StatusOK, gin.H{
			"items":          items,
			"nodes":          nodes,
			"total":          len(items),
			"clusters_ok":    clustersOK,
			"cluster_errors": clusterErrors,
		})
	}
}

func heatmap(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		hours, _ := strconv.Atoi(c.DefaultQuery("hours", "168")) // 7d
		limit, _ := strconv.Atoi(c.DefaultQuery("limit", "20000"))
		since := time.Now().Add(-time.Duration(hours) * time.Hour)
		points, err := d.CH.VolumeHeatmap(c.Request.Context(), since, limit)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": points, "since": since})
	}
}

func volumeFeatures(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		idU, err := strconv.ParseUint(c.Param("id"), 10, 32)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		f, err := d.CH.LatestVolumeFeatures(c.Request.Context(), uint32(idU))
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, f)
	}
}

func scoreOne(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		idU, err := strconv.ParseUint(c.Param("id"), 10, 32)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		// fetch volume from master
		vols, err := d.Sw.ListVolumes(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		for _, v := range vols {
			if v.ID == uint32(idU) {
				feat, _ := d.CH.LatestVolumeFeatures(c.Request.Context(), v.ID)
				// Use rule-only quick scoring; scorer is owned by scheduler in real run
				c.JSON(http.StatusOK, gin.H{"volume": v, "features_snapshot": feat})
				return
			}
		}
		c.JSON(http.StatusNotFound, gin.H{"error": "volume not found"})
	}
}

// ---------------- Policies ----------------

func listPolicies(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		ps, err := d.PG.ListPolicies(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": ps})
	}
}

func upsertPolicy(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var p store.Policy
		if err := c.BindJSON(&p); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var paramsDecoded interface{}
		if len(p.Params) > 0 {
			if err := json.Unmarshal(p.Params, &paramsDecoded); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "params: invalid json"})
				return
			}
			if err := validation.Default.Validate("policy.params", paramsDecoded); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
				return
			}
		}
		id, err := d.PG.UpsertPolicy(c.Request.Context(), p)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "upsert", "policy", id.String(), p)
		c.JSON(http.StatusOK, gin.H{"id": id})
	}
}

// ---------------- Tasks ----------------

func listTasks(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		status := c.Query("status")
		limit, _ := strconv.Atoi(c.DefaultQuery("limit", "200"))
		ts, err := d.PG.ListTasks(c.Request.Context(), status, limit)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": ts})
	}
}

func approveTask(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		if err := d.PG.UpdateTaskStatus(c.Request.Context(), id, "approved", userOf(c)); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "approve", "task", id.String(), nil)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

func cancelTask(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		if err := d.PG.UpdateTaskStatus(c.Request.Context(), id, "cancelled", userOf(c)); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// runTask executes a single approved task synchronously (UI "Run now" button).
func runTask(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		ts, err := d.PG.ListTasks(c.Request.Context(), "", 1000)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		var found *store.Task
		for i := range ts {
			if ts[i].ID == id {
				found = &ts[i]
				break
			}
		}
		if found == nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "task not found"})
			return
		}
		// Detach from request ctx: long-running tasks (volume.fix.replication,
		// EC encode, …) easily outlive the HTTP request, and cancelling the
		// executor mid-flight leaves the execution row stuck in 'running' with
		// no log. We block on `started` so the caller still gets execution_id
		// once the row has been inserted.
		bgCtx := context.WithoutCancel(c.Request.Context())
		started := make(chan uuid.UUID, 1)
		go func() {
			task := *found
			id, err := d.Exec.Run(bgCtx, task, func(execID uuid.UUID) {
				started <- execID
			})
			if err != nil {
				// Errors are persisted on the execution row by Run(); log here
				// for the operator tailing controller logs.
				_ = id
			}
		}()
		select {
		case execID := <-started:
			c.JSON(http.StatusOK, gin.H{"execution_id": execID})
		case <-time.After(5 * time.Second):
			c.JSON(http.StatusGatewayTimeout, gin.H{"error": "execution did not start in time"})
		}
	}
}

// stopTask interrupts a currently-running execution and marks the task
// failed so the operator can re-approve / retry. Two layers:
//  1. Cancel the executor goroutine (interrupts mid-step shell command).
//  2. Force the DB rows into terminal state — defends against a stuck
//     execution where the goroutine already died (e.g. controller crashed
//     mid-flight, leaving 'running' rows behind).
func stopTask(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		exec, err := d.PG.LatestExecutionForTask(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		cancelled := false
		if exec != nil && exec.Status == "running" {
			cancelled = d.Exec.Cancel(exec.ID)
			errMsg := "stopped by user"
			if ferr := d.PG.FinishExecution(c.Request.Context(), exec.ID, "failed", exec.Log, &errMsg); ferr != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": ferr.Error()})
				return
			}
		}
		if err := d.PG.UpdateTaskStatus(c.Request.Context(), id, "failed", userOf(c)); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "stop", "task", id.String(), nil)
		c.JSON(http.StatusOK, gin.H{"ok": true, "cancelled_inflight": cancelled})
	}
}

// retryTask resets a failed/cancelled task back to 'approved' so a fresh
// execution runs. Refuses if the task isn't in a terminal failure state —
// the operator must explicitly Cancel a pending/approved task first.
func retryTask(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		ts, err := d.PG.ListTasks(c.Request.Context(), "", 5000)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		var found *store.Task
		for i := range ts {
			if ts[i].ID == id {
				found = &ts[i]
				break
			}
		}
		if found == nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "task not found"})
			return
		}
		if found.Status != "failed" && found.Status != "cancelled" {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("task is %s, only failed/cancelled tasks can be retried", found.Status)})
			return
		}
		if err := d.PG.UpdateTaskStatus(c.Request.Context(), id, "approved", userOf(c)); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "retry", "task", id.String(), nil)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// listClusterPressure exposes the current per-cluster pressure scores to
// the UI. Returns the in-memory snapshot (fast path) merged with the latest
// DB-persisted scores for clusters the sampler hasn't seen yet.
func listClusterPressure(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		items := []gin.H{}
		if d.Pressure != nil {
			for _, sc := range d.Pressure.All() {
				items = append(items, gin.H{
					"cluster_id": sc.Cluster,
					"score":      sc.Value,
					"components": sc.Components,
					"sampled_at": sc.SampledAt,
					"is_busy":    sc.Value >= d.Pressure.Threshold(),
				})
			}
		}
		thr := 0.6
		if d.Pressure != nil {
			thr = d.Pressure.Threshold()
		}
		c.JSON(http.StatusOK, gin.H{"items": items, "threshold": thr})
	}
}

// taskAutonomy returns the autonomy_score + pipeline_runs timeline for one
// task. Used by the UI 决策档案 card.
func taskAutonomy(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		t, err := d.PG.GetTask(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		runs, err := d.PG.ListPipelineRuns(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"task_id":        t.ID,
			"autonomy_score": t.AutonomyScore,
			"pipeline_runs":  runs,
		})
	}
}

func getTask(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		t, err := d.PG.GetTask(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, t)
	}
}

func latestExecutionForTask(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		e, err := d.PG.LatestExecutionForTask(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if e == nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "no execution for this task"})
			return
		}
		c.JSON(http.StatusOK, e)
	}
}

// runPostmortem (re)runs the AI failure diagnosis on demand. Used when the
// auto-trigger missed (e.g. AI provider was down at the time) or when the
// operator wants a fresh opinion.
func runPostmortem(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		execID, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		exec, err := d.PG.GetExecution(c.Request.Context(), execID)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		ts, err := d.PG.ListTasks(c.Request.Context(), "", 5000)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		var task *store.Task
		for i := range ts {
			if ts[i].ID == exec.TaskID {
				task = &ts[i]
				break
			}
		}
		if task == nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "task for execution not found"})
			return
		}
		errStr := ""
		if exec.Error != nil {
			errStr = *exec.Error
		}
		res, err := d.AIReview.RunPostmortem(c.Request.Context(), aireview.PostmortemInput{
			TaskID: task.ID, ExecID: exec.ID, VolumeID: uint32(task.VolumeID),
			Action: task.Action, SkillKey: task.Action,
			Status: exec.Status, Error: errStr, Log: exec.Log,
		})
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		if perr := d.PG.SetExecutionPostmortem(c.Request.Context(), exec.ID, res); perr != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": perr.Error()})
			return
		}
		c.JSON(http.StatusOK, res)
	}
}

// applyPostmortemSuggestion applies the AI's recommendation in one click.
// Today the only "apply" action is retry — translate verdict→ task transition:
//   transient_retry / adjust_and_retry → reset task to approved (operator
//                                          must still hit Run, no auto-execute)
//   permanent_abort / needs_human       → leave alone, return 409
//
// Sprint 5+ can extend this to actually mutate task params for adjust_and_retry.
func applyPostmortemSuggestion(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		execID, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		exec, err := d.PG.GetExecution(c.Request.Context(), execID)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		if len(exec.AIPostmortem) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "no postmortem available — run diagnosis first"})
			return
		}
		var pm struct {
			Verdict string `json:"verdict"`
		}
		if err := json.Unmarshal(exec.AIPostmortem, &pm); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "decode postmortem: " + err.Error()})
			return
		}
		switch pm.Verdict {
		case "transient_retry", "adjust_and_retry":
			// Land at 'scheduled' instead of 'approved' so the pressure-aware
			// dispatcher waits for a quiet moment before re-firing. The next
			// dispatch tick promotes scheduled→approved once pressure drops
			// below pressure.threshold.
			if err := d.PG.UpdateTaskStatus(c.Request.Context(), exec.TaskID, "scheduled", userOf(c)); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			_ = d.PG.Audit(c.Request.Context(), userOf(c), "apply_postmortem", "task", exec.TaskID.String(), pm)
			c.JSON(http.StatusOK, gin.H{
				"ok":      true,
				"applied": "task_set_to_scheduled",
				"task_id": exec.TaskID,
				"note":    "Task will run automatically when target cluster pressure drops below threshold.",
			})
		case "permanent_abort", "needs_human":
			c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf("verdict=%s — no automatic action available, requires human decision", pm.Verdict)})
		default:
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("unknown verdict %q", pm.Verdict)})
		}
	}
}

// ---------------- Executions ----------------

func getExecution(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		e, err := d.PG.GetExecution(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, e)
	}
}

func rollbackExecution(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		if err := d.Exec.Rollback(c.Request.Context(), id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "rollback", "execution", id.String(), nil)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// ---------------- AI ----------------

// listAIProviders kept as legacy fallback when no DB rows exist.
// Routes now point to listAIProvidersV2 — this stays so external callers
// referencing /ai/providers in old scripts still work via the V2 wrapper.
func listAIProviders(d Deps) gin.HandlerFunc {
	return listAIProvidersV2(d)
}

func testAI(d Deps) gin.HandlerFunc {
	type req struct {
		VolumeID uint32             `json:"volume_id"`
		Action   string             `json:"action"`
		Score    float64            `json:"score"`
		Features map[string]float64 `json:"features"`
	}
	return func(c *gin.Context) {
		var r req
		if err := c.BindJSON(&r); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		out, err := d.AI.Explain(c.Request.Context(), ai.ExplainInput{
			VolumeID: r.VolumeID, Action: r.Action, Score: r.Score, Features: r.Features,
		})
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"explanation": out, "provider": d.AI.Name()})
	}
}

// ---------------- Scheduler / Dashboard ----------------

func scoreNow(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Optional ?cluster_id=<uuid>[,<uuid>...] scopes the scan to those
		// clusters. Empty / missing → scan every enabled cluster.
		var filter []uuid.UUID
		if raw := c.Query("cluster_id"); raw != "" {
			for _, part := range strings.Split(raw, ",") {
				if id, err := uuid.Parse(strings.TrimSpace(part)); err == nil {
					filter = append(filter, id)
				}
			}
		}
		report, err := d.Sched.ScoreOnce(c.Request.Context(), filter...)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "report": report})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "score_now", "scheduler",
			fmt.Sprintf("filter=%v", filter), nil)
		c.JSON(http.StatusOK, gin.H{"ok": true, "report": report})
	}
}

// dashboardSummary returns counts and TB-by-tier estimates for the home page.
// Iterates every enabled cluster and aggregates — never 502s on a single
// cluster outage. Failed clusters surface in the `cluster_errors` field so
// the UI can show a degraded banner instead of a hard error.
func dashboardSummary(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx := c.Request.Context()
		clusters, err := d.PG.ListClusters(ctx)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		var hot, warm, cold, totalBytes uint64
		totalVols := 0
		clustersOK := 0
		clusterErrors := []gin.H{}
		for _, cl := range clusters {
			if !cl.Enabled {
				continue
			}
			vols, _, lvErr := fetchClusterVolumes(ctx, d.Sw, cl.MasterAddr, cl.WeedBinPath)
			if lvErr != nil {
				clusterErrors = append(clusterErrors, gin.H{
					"cluster": cl.Name, "master": cl.MasterAddr, "error": lvErr.Error(),
				})
				continue
			}
			clustersOK++
			for _, v := range vols {
				totalBytes += v.Size
				totalVols++
				switch v.DiskType {
				case "ssd", "nvme":
					hot += v.Size
				case "hdd", "":
					warm += v.Size
				default:
					cold += v.Size
				}
			}
		}

		pending, _ := d.PG.ListTasks(ctx, "pending", 1000)
		approved, _ := d.PG.ListTasks(ctx, "approved", 1000)
		running, _ := d.PG.ListTasks(ctx, "running", 1000)

		c.JSON(http.StatusOK, gin.H{
			"volumes_total":  totalVols,
			"bytes_total":    totalBytes,
			"bytes_hot":      hot,
			"bytes_warm":     warm,
			"bytes_cold":     cold,
			"tasks_pending":  len(pending),
			"tasks_approved": len(approved),
			"tasks_running":  len(running),
			"ai_provider":    d.AI.Name(),
			"clusters_total": len(clusters),
			"clusters_ok":    clustersOK,
			"cluster_errors": clusterErrors,
		})
	}
}

func userOf(c *gin.Context) string {
	if u := c.GetHeader("X-User"); u != "" {
		return u
	}
	return "anonymous"
}

// listAudit returns recent audit_log rows with optional filter chips.
// Query params: ?actor=&action=&target_kind=&target_id=&since=2026-05-10T00:00:00Z&limit=200
func listAudit(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		f := store.AuditFilter{
			Actor:      c.Query("actor"),
			Action:     c.Query("action"),
			TargetKind: c.Query("target_kind"),
			TargetID:   c.Query("target_id"),
		}
		if v := c.Query("limit"); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				f.Limit = n
			}
		}
		if v := c.Query("since"); v != "" {
			if t, err := time.Parse(time.RFC3339, v); err == nil {
				f.Since = t
			}
		}
		items, err := d.PG.ListAudit(c.Request.Context(), f)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": items, "total": len(items)})
	}
}

// auditFacets returns distinct values for the actor/action/target_kind
// columns so the UI can populate filter dropdowns without hand-maintained
// enum lists.
func auditFacets(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx := c.Request.Context()
		actors, _ := d.PG.AuditDistinct(ctx, "actor", 100)
		actions, _ := d.PG.AuditDistinct(ctx, "action", 200)
		kinds, _ := d.PG.AuditDistinct(ctx, "target_kind", 50)
		c.JSON(http.StatusOK, gin.H{
			"actors":  actors,
			"actions": actions,
			"kinds":   kinds,
		})
	}
}

// ensure json import is used in case future handlers grow
var _ = json.Marshal
