package store

// Fleet-wide operations rollup. Cross-cluster aggregates used by the
// Activity → Fleet tab to answer: where are tasks queueing up, what
// kinds of actions are failing, and what's the throughput trend.
//
// All queries are scoped by a time window so the dashboard can stay
// performant on the tasks/executions tables as they grow. The window
// is clamped server-side in api/ops_fleet.go.

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// FleetClusterTasks is one row of the per-cluster task rollup.
type FleetClusterTasks struct {
	ClusterID      *uuid.UUID `json:"cluster_id,omitempty"`
	Pending        int        `json:"pending"`
	Running        int        `json:"running"`
	SucceededInWin int        `json:"succeeded_in_window"`
	FailedInWin    int        `json:"failed_in_window"`
}

// FleetTasksByCluster returns per-cluster counts. Window applies only
// to the terminal-state buckets — pending / running are always
// "right now" because they're the queue depth.
func (p *PG) FleetTasksByCluster(ctx context.Context, window time.Duration) ([]FleetClusterTasks, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT cluster_id,
		       COUNT(*) FILTER (WHERE status = 'pending'),
		       COUNT(*) FILTER (WHERE status IN ('approved','running')),
		       COUNT(*) FILTER (WHERE status = 'succeeded'  AND created_at > NOW() - $1::interval),
		       COUNT(*) FILTER (WHERE status IN ('failed','rolled_back') AND created_at > NOW() - $1::interval)
		FROM tasks
		GROUP BY cluster_id
		ORDER BY COUNT(*) FILTER (WHERE status IN ('approved','running','pending')) DESC NULLS LAST`,
		fmt.Sprintf("%d seconds", int(window.Seconds())),
	)
	if err != nil {
		return nil, fmt.Errorf("fleet tasks by cluster: %w", err)
	}
	defer rows.Close()
	out := []FleetClusterTasks{}
	for rows.Next() {
		var r FleetClusterTasks
		if err := rows.Scan(&r.ClusterID, &r.Pending, &r.Running, &r.SucceededInWin, &r.FailedInWin); err != nil {
			return nil, fmt.Errorf("scan fleet tasks: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// FleetStuckTask is a task that's been in a non-terminal state long
// enough to suggest the executor is wedged.
type FleetStuckTask struct {
	ID         uuid.UUID  `json:"id"`
	ClusterID  *uuid.UUID `json:"cluster_id,omitempty"`
	Action     string     `json:"action"`
	Collection string     `json:"collection"`
	VolumeID   int32      `json:"volume_id"`
	Status     string     `json:"status"`
	AgeSeconds int64      `json:"age_seconds"`
	CreatedAt  time.Time  `json:"created_at"`
}

// FleetStuckTasks surfaces tasks the operator should investigate:
//   - running > 1h (per the SLO; configurable via runningThreshold)
//   - pending > 24h (approval staleness)
//
// Top 20, oldest first. Newer stuck tasks crowd the dashboard;
// we'd rather show the long-standing ones since they're more
// definitely problematic.
func (p *PG) FleetStuckTasks(ctx context.Context, runningThreshold, pendingThreshold time.Duration, limit int) ([]FleetStuckTask, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT id, cluster_id, action, collection, volume_id, status,
		       EXTRACT(EPOCH FROM (NOW() - created_at))::bigint AS age_seconds,
		       created_at
		FROM tasks
		WHERE (status IN ('approved','running') AND created_at < NOW() - $1::interval)
		   OR (status = 'pending'               AND created_at < NOW() - $2::interval)
		ORDER BY created_at ASC
		LIMIT $3`,
		fmt.Sprintf("%d seconds", int(runningThreshold.Seconds())),
		fmt.Sprintf("%d seconds", int(pendingThreshold.Seconds())),
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("fleet stuck tasks: %w", err)
	}
	defer rows.Close()
	out := []FleetStuckTask{}
	for rows.Next() {
		var r FleetStuckTask
		if err := rows.Scan(&r.ID, &r.ClusterID, &r.Action, &r.Collection,
			&r.VolumeID, &r.Status, &r.AgeSeconds, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan stuck: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// FleetActionFailureRow is per-action failure stats over the window.
type FleetActionFailureRow struct {
	Action      string  `json:"action"`
	Total       int     `json:"total"`
	Failed      int     `json:"failed"`
	FailureRate float64 `json:"failure_rate"`
}

// FleetActionFailures returns rolled-back + failed counts per action,
// only for actions that ran in the window. min_total guards against
// "0/1 failed = 100%" noise — actions with fewer than min_total runs
// are excluded.
func (p *PG) FleetActionFailures(ctx context.Context, window time.Duration, minTotal int) ([]FleetActionFailureRow, error) {
	if minTotal < 1 {
		minTotal = 1
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT action,
		       COUNT(*) AS total,
		       COUNT(*) FILTER (WHERE status IN ('failed','rolled_back')) AS failed
		FROM tasks
		WHERE created_at > NOW() - $1::interval
		  AND status IN ('succeeded','failed','rolled_back')
		GROUP BY action
		HAVING COUNT(*) >= $2
		ORDER BY (COUNT(*) FILTER (WHERE status IN ('failed','rolled_back')))::float
		       / NULLIF(COUNT(*),0) DESC,
		         COUNT(*) DESC
		LIMIT 20`,
		fmt.Sprintf("%d seconds", int(window.Seconds())),
		minTotal,
	)
	if err != nil {
		return nil, fmt.Errorf("fleet action failures: %w", err)
	}
	defer rows.Close()
	out := []FleetActionFailureRow{}
	for rows.Next() {
		var r FleetActionFailureRow
		if err := rows.Scan(&r.Action, &r.Total, &r.Failed); err != nil {
			return nil, fmt.Errorf("scan action: %w", err)
		}
		if r.Total > 0 {
			r.FailureRate = float64(r.Failed) / float64(r.Total)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// FleetDailyThroughput is one day of execution counts.
type FleetDailyThroughput struct {
	Day       string `json:"day"` // YYYY-MM-DD
	Started   int    `json:"started"`
	Succeeded int    `json:"succeeded"`
	Failed    int    `json:"failed"`
}

// FleetDailyThroughput returns a row per calendar day in the window.
// generate_series fills in zero-count days so the chart line is
// continuous; otherwise quiet days would compress the trend visually.
func (p *PG) FleetDailyThroughput(ctx context.Context, days int) ([]FleetDailyThroughput, error) {
	if days <= 0 || days > 90 {
		days = 7
	}
	rows, err := p.Pool.Query(ctx, `
		WITH series AS (
		  SELECT generate_series(
		           date_trunc('day', NOW()) - ($1::int - 1 || ' days')::interval,
		           date_trunc('day', NOW()),
		           '1 day'::interval
		         ) AS day
		)
		SELECT TO_CHAR(s.day, 'YYYY-MM-DD') AS day_str,
		       COUNT(e.id)                                                          AS started,
		       COUNT(*) FILTER (WHERE e.status = 'succeeded')                       AS succeeded,
		       COUNT(*) FILTER (WHERE e.status IN ('failed','rolled_back'))         AS failed
		FROM series s
		LEFT JOIN executions e
		       ON date_trunc('day', e.started_at) = s.day
		GROUP BY s.day
		ORDER BY s.day ASC`,
		days,
	)
	if err != nil {
		return nil, fmt.Errorf("fleet daily throughput: %w", err)
	}
	defer rows.Close()
	out := []FleetDailyThroughput{}
	for rows.Next() {
		var r FleetDailyThroughput
		if err := rows.Scan(&r.Day, &r.Started, &r.Succeeded, &r.Failed); err != nil {
			return nil, fmt.Errorf("scan throughput: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
