package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// AIReview is the parent row tracking one multi-round review run.
type AIReview struct {
	ID           uuid.UUID  `json:"id"`
	TaskID       uuid.UUID  `json:"task_id"`
	Verdict      *string    `json:"verdict,omitempty"`
	Confidence   *float64   `json:"confidence,omitempty"`
	ProviderID   *uuid.UUID `json:"provider_id,omitempty"`
	ProviderName string     `json:"provider_name"`
	Status       string     `json:"status"`
	Error        string     `json:"error,omitempty"`
	StartedAt    time.Time  `json:"started_at"`
	FinishedAt   *time.Time `json:"finished_at,omitempty"`
}

// AIReviewRound is one round (initial_scan / deep_analysis / devils_advocate).
type AIReviewRound struct {
	ID          uuid.UUID       `json:"id"`
	ReviewID    uuid.UUID       `json:"review_id"`
	RoundNumber int             `json:"round_number"`
	RoundKind   string          `json:"round_kind"`
	Verdict     *string         `json:"verdict,omitempty"`
	Confidence  *float64        `json:"confidence,omitempty"`
	Reasoning   string          `json:"reasoning"`
	Factors     json.RawMessage `json:"factors"`
	Prompt      string          `json:"prompt,omitempty"`
	RawResponse string          `json:"raw_response,omitempty"`
	DurationMs  *int            `json:"duration_ms,omitempty"`
	Error       string          `json:"error,omitempty"`
	StartedAt   time.Time       `json:"started_at"`
}

// CreateAIReview inserts a new review row in 'running' status. The caller
// then writes rounds via UpsertAIReviewRound and finalizes via FinishAIReview.
func (p *PG) CreateAIReview(ctx context.Context, taskID uuid.UUID, providerID *uuid.UUID, providerName string) (uuid.UUID, error) {
	var id uuid.UUID
	err := p.Pool.QueryRow(ctx, `
		INSERT INTO ai_reviews (task_id, provider_id, provider_name)
		VALUES ($1,$2,$3) RETURNING id`,
		taskID, providerID, providerName).Scan(&id)
	if err != nil {
		return uuid.Nil, fmt.Errorf("create ai review: %w", err)
	}
	return id, nil
}

func (p *PG) UpsertAIReviewRound(ctx context.Context, r AIReviewRound) error {
	if len(r.Factors) == 0 {
		r.Factors = json.RawMessage("[]")
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO ai_review_rounds
		  (review_id, round_number, round_kind, verdict, confidence,
		   reasoning, factors, prompt, raw_response, duration_ms, error)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULLIF($11,''))
		ON CONFLICT (review_id, round_number) DO UPDATE SET
		  round_kind   = EXCLUDED.round_kind,
		  verdict      = EXCLUDED.verdict,
		  confidence   = EXCLUDED.confidence,
		  reasoning    = EXCLUDED.reasoning,
		  factors      = EXCLUDED.factors,
		  prompt       = EXCLUDED.prompt,
		  raw_response = EXCLUDED.raw_response,
		  duration_ms  = EXCLUDED.duration_ms,
		  error        = EXCLUDED.error`,
		r.ReviewID, r.RoundNumber, r.RoundKind, r.Verdict, r.Confidence,
		r.Reasoning, r.Factors, r.Prompt, r.RawResponse, r.DurationMs, r.Error)
	if err != nil {
		return fmt.Errorf("upsert ai review round: %w", err)
	}
	return nil
}

// FinishAIReview persists the aggregate verdict + status. errMsg empty means
// the run completed; otherwise the row is marked failed.
func (p *PG) FinishAIReview(ctx context.Context, id uuid.UUID, verdict string, confidence float64, errMsg string) error {
	status := "complete"
	if errMsg != "" {
		status = "failed"
	}
	_, err := p.Pool.Exec(ctx, `
		UPDATE ai_reviews
		SET verdict = NULLIF($1,''),
		    confidence = $2,
		    status = $3,
		    error = NULLIF($4,''),
		    finished_at = now()
		WHERE id = $5`, verdict, confidence, status, errMsg, id)
	if err != nil {
		return fmt.Errorf("finish ai review: %w", err)
	}
	return nil
}

// GetReviewWithRounds is the page-load query for the task detail UI: one
// review (latest) plus its rounds in order.
func (p *PG) GetReviewWithRounds(ctx context.Context, taskID uuid.UUID) (*AIReview, []AIReviewRound, error) {
	row := p.Pool.QueryRow(ctx, `
		SELECT id, task_id, verdict, confidence, provider_id, provider_name,
		       status, COALESCE(error,''), started_at, finished_at
		FROM ai_reviews
		WHERE task_id = $1
		ORDER BY started_at DESC
		LIMIT 1`, taskID)
	var r AIReview
	if err := row.Scan(&r.ID, &r.TaskID, &r.Verdict, &r.Confidence,
		&r.ProviderID, &r.ProviderName, &r.Status, &r.Error,
		&r.StartedAt, &r.FinishedAt); err != nil {
		return nil, nil, err
	}

	rows, err := p.Pool.Query(ctx, `
		SELECT id, review_id, round_number, round_kind, verdict, confidence,
		       reasoning, factors, prompt, raw_response, duration_ms,
		       COALESCE(error,''), started_at
		FROM ai_review_rounds
		WHERE review_id = $1
		ORDER BY round_number`, r.ID)
	if err != nil {
		return &r, nil, fmt.Errorf("list rounds: %w", err)
	}
	defer rows.Close()
	out := []AIReviewRound{}
	for rows.Next() {
		var rd AIReviewRound
		if err := rows.Scan(&rd.ID, &rd.ReviewID, &rd.RoundNumber, &rd.RoundKind,
			&rd.Verdict, &rd.Confidence, &rd.Reasoning, &rd.Factors,
			&rd.Prompt, &rd.RawResponse, &rd.DurationMs, &rd.Error, &rd.StartedAt); err != nil {
			return &r, nil, fmt.Errorf("scan round: %w", err)
		}
		out = append(out, rd)
	}
	return &r, out, nil
}
