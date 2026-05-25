package store

// AI usage events — per-call token accounting written by the AI
// provider layer via a request-scoped UsageRecorder. The rows are
// raw events; aggregation happens here on read so the dashboard
// can slice by provider, model, operation, or day without a
// materialized view.

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// AIUsageEvent is one captured LLM round trip. Most fields map
// 1:1 to ai.Usage; user_id and chat_id are attribution columns
// the API layer fills in from the request context.
type AIUsageEvent struct {
	OccurredAt   time.Time  `json:"occurred_at"`
	Provider     string     `json:"provider"`
	Model        string     `json:"model"`
	Operation    string     `json:"operation"`
	InputTokens  int64      `json:"input_tokens"`
	OutputTokens int64      `json:"output_tokens"`
	LatencyMS    int        `json:"latency_ms"`
	Err          string     `json:"error,omitempty"`
	UserID       *uuid.UUID `json:"user_id,omitempty"`
	ChatID       *uuid.UUID `json:"chat_id,omitempty"`
}

// InsertAIUsage writes one event. Latency-sensitive — gets called
// on every LLM call — so it's a single parameterized insert with
// no read-back.
func (p *PG) InsertAIUsage(ctx context.Context, e AIUsageEvent) error {
	when := e.OccurredAt
	if when.IsZero() {
		when = time.Now()
	}
	errStr := e.Err
	if len(errStr) > 200 {
		errStr = errStr[:200]
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO ai_usage_events
		    (occurred_at, provider, model, operation,
		     input_tokens, output_tokens, latency_ms, error,
		     user_id, chat_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		when, e.Provider, e.Model, e.Operation,
		e.InputTokens, e.OutputTokens, e.LatencyMS, errStr,
		e.UserID, e.ChatID)
	return err
}

// AIUsageDailyRow is one (day × provider × model × operation)
// rollup row for the dashboard's stacked-bar history.
type AIUsageDailyRow struct {
	Day          time.Time `json:"day"`
	Provider     string    `json:"provider"`
	Model        string    `json:"model"`
	Operation    string    `json:"operation"`
	Calls        int64     `json:"calls"`
	Errors       int64     `json:"errors"`
	InputTokens  int64     `json:"input_tokens"`
	OutputTokens int64     `json:"output_tokens"`
	AvgLatencyMS int64     `json:"avg_latency_ms"`
}

// AIUsageDaily returns per-day rollups for the last `days` days,
// keyed by (provider, model, operation). Empty result is normal
// for a fresh install — the panel renders an empty state.
func (p *PG) AIUsageDaily(ctx context.Context, days int) ([]AIUsageDailyRow, error) {
	if days <= 0 || days > 365 {
		days = 7
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT
		  date_trunc('day', occurred_at) AS day,
		  provider, model, operation,
		  COUNT(*)                                   AS calls,
		  COUNT(*) FILTER (WHERE error <> '')        AS errors,
		  COALESCE(SUM(input_tokens),  0)            AS input_tokens,
		  COALESCE(SUM(output_tokens), 0)            AS output_tokens,
		  COALESCE(AVG(latency_ms), 0)::bigint       AS avg_latency_ms
		FROM ai_usage_events
		WHERE occurred_at >= now() - ($1::int || ' days')::interval
		GROUP BY 1, provider, model, operation
		ORDER BY 1 ASC, calls DESC`, days)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AIUsageDailyRow{}
	for rows.Next() {
		var r AIUsageDailyRow
		if err := rows.Scan(&r.Day, &r.Provider, &r.Model, &r.Operation,
			&r.Calls, &r.Errors, &r.InputTokens, &r.OutputTokens, &r.AvgLatencyMS); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// AIUsageModelTotal is the model-level rollup card across the
// chosen window — what most operators look at first.
type AIUsageModelTotal struct {
	Provider     string `json:"provider"`
	Model        string `json:"model"`
	Calls        int64  `json:"calls"`
	Errors       int64  `json:"errors"`
	InputTokens  int64  `json:"input_tokens"`
	OutputTokens int64  `json:"output_tokens"`
	AvgLatencyMS int64  `json:"avg_latency_ms"`
}

func (p *PG) AIUsageByModel(ctx context.Context, days int) ([]AIUsageModelTotal, error) {
	if days <= 0 || days > 365 {
		days = 7
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT provider, model,
		       COUNT(*),
		       COUNT(*) FILTER (WHERE error <> ''),
		       COALESCE(SUM(input_tokens),  0),
		       COALESCE(SUM(output_tokens), 0),
		       COALESCE(AVG(latency_ms), 0)::bigint
		FROM ai_usage_events
		WHERE occurred_at >= now() - ($1::int || ' days')::interval
		GROUP BY provider, model
		ORDER BY COUNT(*) DESC`, days)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AIUsageModelTotal{}
	for rows.Next() {
		var r AIUsageModelTotal
		if err := rows.Scan(&r.Provider, &r.Model, &r.Calls, &r.Errors,
			&r.InputTokens, &r.OutputTokens, &r.AvgLatencyMS); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// AIUsageTopUser is the per-user usage rollup, surfacing the most
// active operators so a quota conversation can be data-driven.
type AIUsageTopUser struct {
	UserID       uuid.UUID `json:"user_id"`
	Username     string    `json:"username"`
	Calls        int64     `json:"calls"`
	InputTokens  int64     `json:"input_tokens"`
	OutputTokens int64     `json:"output_tokens"`
}

// AIModelPricing is the operator-managed price row that the API
// layer joins against usage rollups to compute estimated cost.
type AIModelPricing struct {
	ID                  uuid.UUID `json:"id"`
	Provider            string    `json:"provider"`
	Model               string    `json:"model"`
	InputPricePer1MTok  float64   `json:"input_price_per_1m_tokens"`
	OutputPricePer1MTok float64   `json:"output_price_per_1m_tokens"`
	Currency            string    `json:"currency"`
	Notes               string    `json:"notes"`
	UpdatedAt           time.Time `json:"updated_at"`
}

// ListAIModelPricing returns every row. The table is tiny (one row
// per priced model) so a full scan is the simplest read.
func (p *PG) ListAIModelPricing(ctx context.Context) ([]AIModelPricing, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT id, provider, model,
		       input_price_per_1m_tokens, output_price_per_1m_tokens,
		       currency, notes, updated_at
		FROM ai_model_pricing
		ORDER BY provider, model`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AIModelPricing{}
	for rows.Next() {
		var r AIModelPricing
		if err := rows.Scan(&r.ID, &r.Provider, &r.Model,
			&r.InputPricePer1MTok, &r.OutputPricePer1MTok,
			&r.Currency, &r.Notes, &r.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// UpsertAIModelPricing inserts or updates a row by (provider, model).
// Notes is free-form operator metadata; zero prices are valid and
// mean "treat as unpriced" on the dashboard.
func (p *PG) UpsertAIModelPricing(ctx context.Context, r AIModelPricing) error {
	if r.Provider == "" || r.Model == "" {
		return fmt.Errorf("provider and model are required")
	}
	if r.Currency == "" {
		r.Currency = "USD"
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO ai_model_pricing
		    (provider, model, input_price_per_1m_tokens, output_price_per_1m_tokens, currency, notes, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6, now())
		ON CONFLICT (provider, model) DO UPDATE SET
		    input_price_per_1m_tokens  = EXCLUDED.input_price_per_1m_tokens,
		    output_price_per_1m_tokens = EXCLUDED.output_price_per_1m_tokens,
		    currency                   = EXCLUDED.currency,
		    notes                      = EXCLUDED.notes,
		    updated_at                 = now()`,
		r.Provider, r.Model, r.InputPricePer1MTok, r.OutputPricePer1MTok, r.Currency, r.Notes)
	return err
}

// DeleteAIModelPricing removes one row by (provider, model). A missing
// row is not an error — pricing is best-effort.
func (p *PG) DeleteAIModelPricing(ctx context.Context, provider, model string) error {
	_, err := p.Pool.Exec(ctx,
		`DELETE FROM ai_model_pricing WHERE provider = $1 AND model = $2`,
		provider, model)
	return err
}

func (p *PG) AIUsageTopUsers(ctx context.Context, days, limit int) ([]AIUsageTopUser, error) {
	if days <= 0 || days > 365 {
		days = 7
	}
	if limit <= 0 || limit > 50 {
		limit = 10
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT u.id, u.username,
		       COUNT(*)                          AS calls,
		       COALESCE(SUM(e.input_tokens),  0) AS in_tok,
		       COALESCE(SUM(e.output_tokens), 0) AS out_tok
		FROM ai_usage_events e
		JOIN users u ON u.id = e.user_id
		WHERE e.occurred_at >= now() - ($1::int || ' days')::interval
		GROUP BY u.id, u.username
		ORDER BY calls DESC
		LIMIT $2`, days, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AIUsageTopUser{}
	for rows.Next() {
		var r AIUsageTopUser
		if err := rows.Scan(&r.UserID, &r.Username, &r.Calls, &r.InputTokens, &r.OutputTokens); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
