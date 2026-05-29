package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// ScoreSnapshot mirrors one row of cluster_score_signals (read side).
type ScoreSnapshot struct {
	ClusterID  uuid.UUID `json:"cluster_id"`
	SnapshotAt time.Time `json:"snapshot_at"`
	Score      float64   `json:"score"`
	Components []byte    `json:"components"`
}

// InsertScoreSnapshot writes one (cluster_id, snapshot_at, score, components)
// row into cluster_score_signals. Called by the durability sampler.
func (p *PG) InsertScoreSnapshot(ctx context.Context, clusterID uuid.UUID, score float64, components []byte) error {
	if len(components) == 0 {
		components = []byte("{}")
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO cluster_score_signals (cluster_id, snapshot_at, score, components)
		VALUES ($1, NOW(), $2, $3::jsonb)`, clusterID, score, components)
	if err != nil {
		return fmt.Errorf("insert score snapshot: %w", err)
	}
	return nil
}

// ScoreHistory returns a time-ordered slice of one cluster's durability score
// for all rows with snapshot_at >= since. Used by GET /clusters/score/history.
func (p *PG) ScoreHistory(ctx context.Context, clusterID uuid.UUID, since time.Time) ([]ScoreSnapshot, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT cluster_id, snapshot_at, score, components
		FROM cluster_score_signals
		WHERE cluster_id = $1 AND snapshot_at >= $2
		ORDER BY snapshot_at ASC`, clusterID, since)
	if err != nil {
		return nil, fmt.Errorf("score history: %w", err)
	}
	defer rows.Close()
	out := []ScoreSnapshot{}
	for rows.Next() {
		var s ScoreSnapshot
		if err := rows.Scan(&s.ClusterID, &s.SnapshotAt, &s.Score, &s.Components); err != nil {
			return nil, fmt.Errorf("scan score history: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// AllScoreHistory returns time-ordered rows for all clusters with
// snapshot_at >= since. Used by GET /clusters/score/history (no ?cluster=)
// to aggregate across all clusters.
func (p *PG) AllScoreHistory(ctx context.Context, since time.Time) ([]ScoreSnapshot, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT cluster_id, snapshot_at, score, components
		FROM cluster_score_signals
		WHERE snapshot_at >= $1
		ORDER BY snapshot_at ASC`, since)
	if err != nil {
		return nil, fmt.Errorf("all score history: %w", err)
	}
	defer rows.Close()
	out := []ScoreSnapshot{}
	for rows.Next() {
		var s ScoreSnapshot
		if err := rows.Scan(&s.ClusterID, &s.SnapshotAt, &s.Score, &s.Components); err != nil {
			return nil, fmt.Errorf("scan all score history: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}
