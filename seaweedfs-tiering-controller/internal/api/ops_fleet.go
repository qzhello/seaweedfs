package api

// Fleet ops rollup. Cross-cluster view answering "where are tasks
// queueing up, what's failing, what's the throughput trend". No AI;
// pure SQL aggregates so the dashboard is fast and the numbers are
// verifiable.
//
// SLO defaults baked in:
//   - "stuck running": > 1 hour in approved/running
//   - "stuck pending": > 24 hours awaiting approval
//
// These are the thresholds that turn a "normal" task into a hotspot
// worth surfacing. Operators can tune via query params.

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const (
	defaultOpsWindow             = 7 * 24 * time.Hour
	maxOpsWindow                 = 30 * 24 * time.Hour
	defaultRunningStuckThreshold = 1 * time.Hour
	defaultPendingStuckThreshold = 24 * time.Hour
)

// opsFleetClusterRow enriches the store row with the cluster's name
// (joined client-side from the cluster list) so the UI doesn't have
// to do another fetch.
type opsFleetClusterRow struct {
	ClusterID      *uuid.UUID `json:"cluster_id,omitempty"`
	Name           string     `json:"name"`
	Pending        int        `json:"pending"`
	Running        int        `json:"running"`
	SucceededInWin int        `json:"succeeded_in_window"`
	FailedInWin    int        `json:"failed_in_window"`
}

// opsFleetResp is the full payload.
type opsFleetResp struct {
	WindowHours     int                          `json:"window_hours"`
	RunningStuckSec int                          `json:"running_stuck_threshold_seconds"`
	PendingStuckSec int                          `json:"pending_stuck_threshold_seconds"`
	Clusters        []opsFleetClusterRow         `json:"clusters"`
	StuckTasks      []opsFleetStuckRow           `json:"stuck_tasks"`
	ActionFailures  []opsFleetActionFailureRow   `json:"action_failures"`
	DailyThroughput []opsFleetDailyThroughputRow `json:"daily_throughput"`
	// Totals are a convenience for the 4-tile header — saves the UI
	// from re-summing per-cluster rows.
	TotalPending   int `json:"total_pending"`
	TotalRunning   int `json:"total_running"`
	TotalSucceeded int `json:"total_succeeded_in_window"`
	TotalFailed    int `json:"total_failed_in_window"`
}

type opsFleetStuckRow struct {
	ID          uuid.UUID  `json:"id"`
	ClusterID   *uuid.UUID `json:"cluster_id,omitempty"`
	ClusterName string     `json:"cluster_name,omitempty"`
	Action      string     `json:"action"`
	Collection  string     `json:"collection"`
	VolumeID    int32      `json:"volume_id"`
	Status      string     `json:"status"`
	AgeSeconds  int64      `json:"age_seconds"`
}

type opsFleetActionFailureRow struct {
	Action      string  `json:"action"`
	Total       int     `json:"total"`
	Failed      int     `json:"failed"`
	FailureRate float64 `json:"failure_rate"`
}

type opsFleetDailyThroughputRow struct {
	Day       string `json:"day"`
	Started   int    `json:"started"`
	Succeeded int    `json:"succeeded"`
	Failed    int    `json:"failed"`
}

// opsFleetOverview handles GET /api/v1/ops/fleet
// Query: window_hours (default 168, max 720)
//        running_stuck_min (default 60)
//        pending_stuck_hours (default 24)
func opsFleetOverview(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		window := defaultOpsWindow
		if h, err := strconv.Atoi(c.Query("window_hours")); err == nil && h > 0 {
			window = time.Duration(h) * time.Hour
			if window > maxOpsWindow {
				window = maxOpsWindow
			}
		}
		runningStuck := defaultRunningStuckThreshold
		if m, err := strconv.Atoi(c.Query("running_stuck_min")); err == nil && m > 0 {
			runningStuck = time.Duration(m) * time.Minute
		}
		pendingStuck := defaultPendingStuckThreshold
		if h, err := strconv.Atoi(c.Query("pending_stuck_hours")); err == nil && h > 0 {
			pendingStuck = time.Duration(h) * time.Hour
		}

		ctx := c.Request.Context()

		clusterRows, err := d.PG.FleetTasksByCluster(ctx, window)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		stuck, err := d.PG.FleetStuckTasks(ctx, runningStuck, pendingStuck, 20)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		failures, err := d.PG.FleetActionFailures(ctx, window, 3) // min 3 runs to count
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		// Day count covers at least the window, capped at 30 — the
		// sparkline gets noisy past that and the SQL is already a
		// generate_series.
		days := int(window/time.Hour/24) + 1
		if days < 7 {
			days = 7
		}
		if days > 30 {
			days = 30
		}
		throughput, err := d.PG.FleetDailyThroughput(ctx, days)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		// Join cluster names — one query, cheap, much friendlier UI
		// than uuids in stuck-task rows.
		clusters, _ := d.PG.ListClusters(ctx)
		nameByID := map[uuid.UUID]string{}
		for _, cl := range clusters {
			nameByID[cl.ID] = cl.Name
		}

		resp := opsFleetResp{
			WindowHours:     int(window.Hours()),
			RunningStuckSec: int(runningStuck.Seconds()),
			PendingStuckSec: int(pendingStuck.Seconds()),
		}
		for _, r := range clusterRows {
			row := opsFleetClusterRow{
				ClusterID:      r.ClusterID,
				Pending:        r.Pending,
				Running:        r.Running,
				SucceededInWin: r.SucceededInWin,
				FailedInWin:    r.FailedInWin,
			}
			if r.ClusterID != nil {
				row.Name = nameByID[*r.ClusterID]
			}
			if row.Name == "" {
				row.Name = "(unassigned)"
			}
			resp.Clusters = append(resp.Clusters, row)
			resp.TotalPending += r.Pending
			resp.TotalRunning += r.Running
			resp.TotalSucceeded += r.SucceededInWin
			resp.TotalFailed += r.FailedInWin
		}
		for _, s := range stuck {
			row := opsFleetStuckRow{
				ID:         s.ID,
				ClusterID:  s.ClusterID,
				Action:     s.Action,
				Collection: s.Collection,
				VolumeID:   s.VolumeID,
				Status:     s.Status,
				AgeSeconds: s.AgeSeconds,
			}
			if s.ClusterID != nil {
				row.ClusterName = nameByID[*s.ClusterID]
			}
			resp.StuckTasks = append(resp.StuckTasks, row)
		}
		for _, f := range failures {
			resp.ActionFailures = append(resp.ActionFailures, opsFleetActionFailureRow{
				Action: f.Action, Total: f.Total, Failed: f.Failed, FailureRate: f.FailureRate,
			})
		}
		for _, t := range throughput {
			resp.DailyThroughput = append(resp.DailyThroughput, opsFleetDailyThroughputRow{
				Day: t.Day, Started: t.Started, Succeeded: t.Succeeded, Failed: t.Failed,
			})
		}
		c.JSON(http.StatusOK, resp)
	}
}
