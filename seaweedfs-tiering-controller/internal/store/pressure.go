package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// PressureSnapshot mirrors one row of cluster_pressure_signals (read side).
type PressureSnapshot struct {
	ClusterID  uuid.UUID `json:"cluster_id"`
	SnapshotAt time.Time `json:"snapshot_at"`
	Score      float64   `json:"pressure_score"`
	Components []byte    `json:"components"`
}

// InsertPressureSnapshotRaw writes one (cluster, ts, score, components_json)
// row. Called by the pressure sampler every 30s (default).
func (p *PG) InsertPressureSnapshotRaw(ctx context.Context, clusterID uuid.UUID, score float64, components []byte) error {
	if len(components) == 0 {
		components = []byte("{}")
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO cluster_pressure_signals (cluster_id, snapshot_at, pressure_score, components)
		VALUES ($1, NOW(), $2, $3::jsonb)`, clusterID, score, components)
	if err != nil {
		return fmt.Errorf("insert pressure snapshot: %w", err)
	}
	return nil
}

// LatestPressurePerCluster returns the most recent score per enabled cluster.
// Used by the UI dashboard + the scheduler on cold start (before the sampler
// has populated the in-memory snapshot).
func (p *PG) LatestPressurePerCluster(ctx context.Context) ([]PressureSnapshot, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT DISTINCT ON (cluster_id) cluster_id, snapshot_at, pressure_score, components
		FROM cluster_pressure_signals
		ORDER BY cluster_id, snapshot_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list latest pressure: %w", err)
	}
	defer rows.Close()
	out := []PressureSnapshot{}
	for rows.Next() {
		var s PressureSnapshot
		if err := rows.Scan(&s.ClusterID, &s.SnapshotAt, &s.Score, &s.Components); err != nil {
			return nil, fmt.Errorf("scan pressure: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// PressureHistory returns a time series of one cluster's pressure for the
// last `since`. Used by Grafana embeds + the Pressure tab on /clusters.
func (p *PG) PressureHistory(ctx context.Context, clusterID uuid.UUID, since time.Time) ([]PressureSnapshot, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT cluster_id, snapshot_at, pressure_score, components
		FROM cluster_pressure_signals
		WHERE cluster_id=$1 AND snapshot_at >= $2
		ORDER BY snapshot_at ASC`, clusterID, since)
	if err != nil {
		return nil, fmt.Errorf("pressure history: %w", err)
	}
	defer rows.Close()
	out := []PressureSnapshot{}
	for rows.Next() {
		var s PressureSnapshot
		if err := rows.Scan(&s.ClusterID, &s.SnapshotAt, &s.Score, &s.Components); err != nil {
			return nil, fmt.Errorf("scan pressure history: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}
