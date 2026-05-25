package store

// AI budgets — monthly spend caps with warn/critical thresholds.
// Evaluated against the same (provider, model) pricing that drives
// the AI Usage panel so the two views always agree.

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

type AIBudget struct {
	ID                   uuid.UUID `json:"id"`
	Name                 string    `json:"name"`
	ScopeType            string    `json:"scope_type"`  // "global" | "provider" | "user"
	ScopeValue           string    `json:"scope_value"` // "" for global
	MonthlyLimit         float64   `json:"monthly_limit"`
	Currency             string    `json:"currency"`
	ThresholdWarnPct     int       `json:"threshold_warn_pct"`
	ThresholdCriticalPct int       `json:"threshold_critical_pct"`
	Active               bool      `json:"active"`
	Notes                string    `json:"notes"`
	CreatedAt            time.Time `json:"created_at"`
	UpdatedAt            time.Time `json:"updated_at"`
}

// AIBudgetState is one budget's live evaluation: how much has been
// spent this calendar month, what percentage of the cap that is,
// and which tier (if any) the spend has crossed.
type AIBudgetState struct {
	Budget        AIBudget `json:"budget"`
	MonthToDate   float64  `json:"month_to_date"`
	PercentOfCap  float64  `json:"percent_of_cap"`
	Tier          string   `json:"tier"`           // "ok" | "warn" | "critical"
	CalendarMonth string   `json:"calendar_month"` // "YYYY-MM"
}

func (p *PG) ListAIBudgets(ctx context.Context) ([]AIBudget, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT id, name, scope_type, scope_value, monthly_limit, currency,
		       threshold_warn_pct, threshold_critical_pct, active, notes,
		       created_at, updated_at
		FROM ai_budgets
		ORDER BY scope_type, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AIBudget{}
	for rows.Next() {
		var b AIBudget
		if err := rows.Scan(&b.ID, &b.Name, &b.ScopeType, &b.ScopeValue,
			&b.MonthlyLimit, &b.Currency, &b.ThresholdWarnPct, &b.ThresholdCriticalPct,
			&b.Active, &b.Notes, &b.CreatedAt, &b.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// UpsertAIBudget inserts or updates by (scope_type, scope_value).
// Returns the resolved row so the API layer can echo the ID back.
func (p *PG) UpsertAIBudget(ctx context.Context, b AIBudget) (AIBudget, error) {
	if b.Name == "" {
		return AIBudget{}, fmt.Errorf("name required")
	}
	switch b.ScopeType {
	case "global":
		b.ScopeValue = "" // canonicalize so the unique key matches
	case "provider", "user":
		if b.ScopeValue == "" {
			return AIBudget{}, fmt.Errorf("scope_value required for scope_type=%s", b.ScopeType)
		}
	default:
		return AIBudget{}, fmt.Errorf("invalid scope_type %q", b.ScopeType)
	}
	if b.MonthlyLimit <= 0 {
		return AIBudget{}, fmt.Errorf("monthly_limit must be > 0")
	}
	if b.ThresholdWarnPct <= 0 || b.ThresholdCriticalPct <= 0 {
		return AIBudget{}, fmt.Errorf("threshold percentages must be > 0")
	}
	if b.Currency == "" {
		b.Currency = "USD"
	}
	row := p.Pool.QueryRow(ctx, `
		INSERT INTO ai_budgets
		    (name, scope_type, scope_value, monthly_limit, currency,
		     threshold_warn_pct, threshold_critical_pct, active, notes, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
		ON CONFLICT (scope_type, scope_value) DO UPDATE SET
		    name                   = EXCLUDED.name,
		    monthly_limit          = EXCLUDED.monthly_limit,
		    currency               = EXCLUDED.currency,
		    threshold_warn_pct     = EXCLUDED.threshold_warn_pct,
		    threshold_critical_pct = EXCLUDED.threshold_critical_pct,
		    active                 = EXCLUDED.active,
		    notes                  = EXCLUDED.notes,
		    updated_at             = now()
		RETURNING id, created_at, updated_at`,
		b.Name, b.ScopeType, b.ScopeValue, b.MonthlyLimit, b.Currency,
		b.ThresholdWarnPct, b.ThresholdCriticalPct, b.Active, b.Notes)
	if err := row.Scan(&b.ID, &b.CreatedAt, &b.UpdatedAt); err != nil {
		return AIBudget{}, err
	}
	return b, nil
}

func (p *PG) DeleteAIBudget(ctx context.Context, id uuid.UUID) error {
	_, err := p.Pool.Exec(ctx, `DELETE FROM ai_budgets WHERE id = $1`, id)
	return err
}

// EvaluateAIBudgets computes month-to-date spend for every active
// budget by joining ai_usage_events × ai_model_pricing in a single
// query, then attributes each event to whichever budgets it touches
// (global + matching provider + matching user). Cheap because the
// per-budget set is small and Postgres can index on occurred_at.
func (p *PG) EvaluateAIBudgets(ctx context.Context) ([]AIBudgetState, error) {
	budgets, err := p.ListAIBudgets(ctx)
	if err != nil {
		return nil, err
	}
	if len(budgets) == 0 {
		return []AIBudgetState{}, nil
	}
	monthStart := startOfMonth(time.Now())
	monthLabel := monthStart.Format("2006-01")

	// Pull priced spend per (provider, user) for the current month.
	// We collapse the join here once and aggregate the buckets per
	// budget in Go — keeps the SQL trivially correct and lets us
	// share the result across N budgets without N queries.
	rows, err := p.Pool.Query(ctx, `
		SELECT e.provider,
		       COALESCE(e.user_id::text, '') AS user_id,
		       COALESCE(SUM(
		           (e.input_tokens  * p.input_price_per_1m_tokens
		          + e.output_tokens * p.output_price_per_1m_tokens) / 1000000.0
		       ), 0) AS cost
		FROM ai_usage_events e
		LEFT JOIN ai_model_pricing p
		       ON p.provider = e.provider AND p.model = e.model
		WHERE e.occurred_at >= $1
		GROUP BY e.provider, COALESCE(e.user_id::text, '')`,
		monthStart)
	if err != nil {
		return nil, fmt.Errorf("evaluate ai budgets: %w", err)
	}
	defer rows.Close()
	type spendRow struct {
		Provider string
		UserID   string
		Cost     float64
	}
	allSpend := []spendRow{}
	for rows.Next() {
		var s spendRow
		if err := rows.Scan(&s.Provider, &s.UserID, &s.Cost); err != nil {
			return nil, err
		}
		allSpend = append(allSpend, s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]AIBudgetState, 0, len(budgets))
	for _, b := range budgets {
		if !b.Active {
			continue
		}
		var mtd float64
		for _, s := range allSpend {
			switch b.ScopeType {
			case "global":
				mtd += s.Cost
			case "provider":
				if s.Provider == b.ScopeValue {
					mtd += s.Cost
				}
			case "user":
				if s.UserID == b.ScopeValue {
					mtd += s.Cost
				}
			}
		}
		pct := 0.0
		if b.MonthlyLimit > 0 {
			pct = mtd / b.MonthlyLimit * 100
		}
		tier := "ok"
		if pct >= float64(b.ThresholdCriticalPct) {
			tier = "critical"
		} else if pct >= float64(b.ThresholdWarnPct) {
			tier = "warn"
		}
		out = append(out, AIBudgetState{
			Budget:        b,
			MonthToDate:   mtd,
			PercentOfCap:  pct,
			Tier:          tier,
			CalendarMonth: monthLabel,
		})
	}
	return out, nil
}

// MarkBudgetAlertFired tries to record that an alert for
// (budget, current-month, tier) has been emitted. Returns true iff
// the row was newly inserted — i.e. the caller should fire the
// alert. A duplicate insert (already fired this month) returns
// false with no error, which is the dedupe path.
func (p *PG) MarkBudgetAlertFired(ctx context.Context, budgetID uuid.UUID, tier string) (bool, error) {
	monthStart := startOfMonth(time.Now())
	tag, err := p.Pool.Exec(ctx, `
		INSERT INTO ai_budget_alert_history (budget_id, calendar_month, tier)
		VALUES ($1, $2, $3)
		ON CONFLICT (budget_id, calendar_month, tier) DO NOTHING`,
		budgetID, monthStart, tier)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// startOfMonth zeroes out everything below month for the time t.
// Lives here rather than a utils package because it's the only
// caller and inlining keeps the dependency graph flat.
func startOfMonth(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, t.Location())
}
