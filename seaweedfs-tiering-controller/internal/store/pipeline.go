package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// PipelineRun is one stage's audit row. The runner writes one per stage so
// the UI can show a full timeline of how each task was decided.
type PipelineRun struct {
	ID          uuid.UUID       `json:"id"`
	TaskID      uuid.UUID       `json:"task_id"`
	ExecutionID *uuid.UUID      `json:"execution_id,omitempty"`
	Stage       string          `json:"stage"`
	Decision    string          `json:"decision"`
	Evidence    json.RawMessage `json:"evidence"`
	Reason      string          `json:"reason"`
	DurationMs  *int            `json:"duration_ms,omitempty"`
	StartedAt   time.Time       `json:"started_at"`
	FinishedAt  *time.Time      `json:"finished_at,omitempty"`
}

func (p *PG) InsertPipelineRun(ctx context.Context, r PipelineRun) (uuid.UUID, error) {
	if r.ID == uuid.Nil {
		r.ID = uuid.New()
	}
	if len(r.Evidence) == 0 {
		r.Evidence = []byte("{}")
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO pipeline_runs (id, task_id, execution_id, stage, decision, evidence, reason, duration_ms, started_at, finished_at)
		VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`,
		r.ID, r.TaskID, r.ExecutionID, r.Stage, r.Decision, r.Evidence, r.Reason,
		r.DurationMs, r.StartedAt, r.FinishedAt)
	if err != nil {
		return uuid.Nil, fmt.Errorf("insert pipeline_run: %w", err)
	}
	return r.ID, nil
}

func (p *PG) ListPipelineRuns(ctx context.Context, taskID uuid.UUID) ([]PipelineRun, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT id, task_id, execution_id, stage, decision, evidence, reason, duration_ms, started_at, finished_at
		FROM pipeline_runs WHERE task_id=$1 ORDER BY started_at ASC`, taskID)
	if err != nil {
		return nil, fmt.Errorf("list pipeline_runs: %w", err)
	}
	defer rows.Close()
	out := []PipelineRun{}
	for rows.Next() {
		var r PipelineRun
		if err := rows.Scan(&r.ID, &r.TaskID, &r.ExecutionID, &r.Stage, &r.Decision,
			&r.Evidence, &r.Reason, &r.DurationMs, &r.StartedAt, &r.FinishedAt); err != nil {
			return nil, fmt.Errorf("scan pipeline_run: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
