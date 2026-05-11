package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

type MonitorTarget struct {
	ID                uuid.UUID  `json:"id"`
	Name              string     `json:"name"`
	Kind              string     `json:"kind"` // http | prometheus_query
	URL               string     `json:"url"`
	Query             string     `json:"query"`
	ThresholdOp       string     `json:"threshold_op"`
	ThresholdValue    *float64   `json:"threshold_value,omitempty"`
	Severity          string     `json:"severity"`
	IntervalSec       int        `json:"interval_sec"`
	TimeoutSec        int        `json:"timeout_sec"`
	FailThreshold     int        `json:"fail_threshold"`
	RecoverThreshold  int        `json:"recover_threshold"`
	ClusterID         *uuid.UUID `json:"cluster_id,omitempty"`
	GatesScheduler    bool       `json:"gates_scheduler"`
	Enabled           bool       `json:"enabled"`
	Notes             string     `json:"notes"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
}

type HealthRow struct {
	TargetID             uuid.UUID  `json:"target_id"`
	State                string     `json:"state"` // healthy | degraded | unknown
	ConsecutiveFailures  int        `json:"consecutive_failures"`
	ConsecutiveSuccesses int        `json:"consecutive_successes"`
	LastOkAt             *time.Time `json:"last_ok_at,omitempty"`
	LastFailureAt        *time.Time `json:"last_failure_at,omitempty"`
	LastError            string     `json:"last_error"`
	LastLatencyMs        int        `json:"last_latency_ms"`
	LastValue            *float64   `json:"last_value,omitempty"`
	UpdatedAt            time.Time  `json:"updated_at"`
}

func (p *PG) ListMonitorTargets(ctx context.Context) ([]MonitorTarget, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT id,name,kind,url,query,threshold_op,threshold_value,severity,
		       interval_sec,timeout_sec,fail_threshold,recover_threshold,
		       cluster_id,gates_scheduler,enabled,notes,created_at,updated_at
		FROM monitor_targets ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("list monitor targets: %w", err)
	}
	defer rows.Close()
	out := []MonitorTarget{}
	for rows.Next() {
		var t MonitorTarget
		if err := rows.Scan(&t.ID, &t.Name, &t.Kind, &t.URL, &t.Query, &t.ThresholdOp, &t.ThresholdValue,
			&t.Severity, &t.IntervalSec, &t.TimeoutSec, &t.FailThreshold, &t.RecoverThreshold,
			&t.ClusterID, &t.GatesScheduler, &t.Enabled, &t.Notes,
			&t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan monitor target: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (p *PG) UpsertMonitorTarget(ctx context.Context, t MonitorTarget) (uuid.UUID, error) {
	if t.ID == uuid.Nil {
		t.ID = uuid.New()
	}
	if t.IntervalSec <= 0 {
		t.IntervalSec = 30
	}
	if t.TimeoutSec <= 0 {
		t.TimeoutSec = 5
	}
	if t.FailThreshold <= 0 {
		t.FailThreshold = 3
	}
	if t.RecoverThreshold <= 0 {
		t.RecoverThreshold = 3
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO monitor_targets
		  (id,name,kind,url,query,threshold_op,threshold_value,severity,
		   interval_sec,timeout_sec,fail_threshold,recover_threshold,
		   cluster_id,gates_scheduler,enabled,notes)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
		ON CONFLICT (name) DO UPDATE SET
		  kind=EXCLUDED.kind, url=EXCLUDED.url, query=EXCLUDED.query,
		  threshold_op=EXCLUDED.threshold_op, threshold_value=EXCLUDED.threshold_value,
		  severity=EXCLUDED.severity, interval_sec=EXCLUDED.interval_sec,
		  timeout_sec=EXCLUDED.timeout_sec, fail_threshold=EXCLUDED.fail_threshold,
		  recover_threshold=EXCLUDED.recover_threshold, cluster_id=EXCLUDED.cluster_id,
		  gates_scheduler=EXCLUDED.gates_scheduler, enabled=EXCLUDED.enabled,
		  notes=EXCLUDED.notes, updated_at=NOW()`,
		t.ID, t.Name, t.Kind, t.URL, t.Query, t.ThresholdOp, t.ThresholdValue,
		t.Severity, t.IntervalSec, t.TimeoutSec, t.FailThreshold, t.RecoverThreshold,
		t.ClusterID, t.GatesScheduler, t.Enabled, t.Notes)
	if err != nil {
		return uuid.Nil, fmt.Errorf("upsert monitor target: %w", err)
	}
	return t.ID, nil
}

func (p *PG) DeleteMonitorTarget(ctx context.Context, id uuid.UUID) error {
	_, err := p.Pool.Exec(ctx, `DELETE FROM monitor_targets WHERE id=$1`, id)
	if err != nil {
		return fmt.Errorf("delete monitor target: %w", err)
	}
	return nil
}

func (p *PG) ListHealthState(ctx context.Context) ([]HealthRow, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT target_id,state,consecutive_failures,consecutive_successes,
		       last_ok_at,last_failure_at,last_error,last_latency_ms,last_value,updated_at
		FROM health_state`)
	if err != nil {
		return nil, fmt.Errorf("list health state: %w", err)
	}
	defer rows.Close()
	out := []HealthRow{}
	for rows.Next() {
		var h HealthRow
		if err := rows.Scan(&h.TargetID, &h.State, &h.ConsecutiveFailures, &h.ConsecutiveSuccesses,
			&h.LastOkAt, &h.LastFailureAt, &h.LastError, &h.LastLatencyMs, &h.LastValue,
			&h.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan health: %w", err)
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// PutHealthRow upserts the current state. Caller has already applied flap logic.
func (p *PG) PutHealthRow(ctx context.Context, h HealthRow) error {
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO health_state
		  (target_id,state,consecutive_failures,consecutive_successes,last_ok_at,last_failure_at,
		   last_error,last_latency_ms,last_value,updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
		ON CONFLICT (target_id) DO UPDATE SET
		  state=EXCLUDED.state, consecutive_failures=EXCLUDED.consecutive_failures,
		  consecutive_successes=EXCLUDED.consecutive_successes,
		  last_ok_at=COALESCE(EXCLUDED.last_ok_at, health_state.last_ok_at),
		  last_failure_at=COALESCE(EXCLUDED.last_failure_at, health_state.last_failure_at),
		  last_error=EXCLUDED.last_error, last_latency_ms=EXCLUDED.last_latency_ms,
		  last_value=EXCLUDED.last_value, updated_at=NOW()`,
		h.TargetID, h.State, h.ConsecutiveFailures, h.ConsecutiveSuccesses,
		h.LastOkAt, h.LastFailureAt, h.LastError, h.LastLatencyMs, h.LastValue)
	if err != nil {
		return fmt.Errorf("put health row: %w", err)
	}
	return nil
}

// AppendHealthSample stores a single probe result for sparkline rendering.
// The table is pruned by TTL outside this function.
func (p *PG) AppendHealthSample(ctx context.Context, targetID uuid.UUID, ok bool, latencyMs int, value *float64) error {
	_, err := p.Pool.Exec(ctx,
		`INSERT INTO health_samples (target_id, ok, latency_ms, value) VALUES ($1,$2,$3,$4)`,
		targetID, ok, latencyMs, value)
	if err != nil {
		return fmt.Errorf("append health sample: %w", err)
	}
	return nil
}

// PruneHealthSamples drops samples older than `keep` to keep the table small.
func (p *PG) PruneHealthSamples(ctx context.Context, keep time.Duration) error {
	_, err := p.Pool.Exec(ctx,
		`DELETE FROM health_samples WHERE sample_at < NOW() - ($1::int * INTERVAL '1 second')`,
		int(keep.Seconds()))
	return err
}

func (p *PG) RecentHealthSamples(ctx context.Context, targetID uuid.UUID, since time.Time) ([]HealthSample, error) {
	rows, err := p.Pool.Query(ctx,
		`SELECT sample_at, ok, latency_ms, value FROM health_samples
		 WHERE target_id=$1 AND sample_at >= $2 ORDER BY sample_at`, targetID, since)
	if err != nil {
		return nil, fmt.Errorf("recent samples: %w", err)
	}
	defer rows.Close()
	out := []HealthSample{}
	for rows.Next() {
		var s HealthSample
		if err := rows.Scan(&s.SampleAt, &s.OK, &s.LatencyMs, &s.Value); err != nil {
			return nil, fmt.Errorf("scan sample: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

type HealthSample struct {
	SampleAt  time.Time `json:"sample_at"`
	OK        bool      `json:"ok"`
	LatencyMs int       `json:"latency_ms"`
	Value     *float64  `json:"value,omitempty"`
}
