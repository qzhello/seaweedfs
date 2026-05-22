package store

import (
	"context"
	"fmt"
	"time"
)

// AIToolPolicy is one row of ai_tool_policies. See
// migrations/pg/029_ai_tool_policies.sql for the design rationale.
type AIToolPolicy struct {
	ToolName  string    `json:"tool_name"`
	RiskLevel string    `json:"risk_level"` // "read" | "write" | "destructive"
	AIAllowed bool      `json:"ai_allowed"`
	Note      string    `json:"note"`
	UpdatedBy string    `json:"updated_by"`
	UpdatedAt time.Time `json:"updated_at"`
}

// ListAIToolPolicies returns every known tool policy. Order is by
// risk_level (read first, then write, then destructive) then by name,
// so the admin UI groups them naturally without client-side sorting.
func (p *PG) ListAIToolPolicies(ctx context.Context) ([]AIToolPolicy, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT tool_name, risk_level, ai_allowed, note, updated_by, updated_at
		FROM ai_tool_policies
		ORDER BY
		  CASE risk_level WHEN 'read' THEN 0 WHEN 'write' THEN 1 ELSE 2 END,
		  tool_name`)
	if err != nil {
		return nil, fmt.Errorf("list ai tool policies: %w", err)
	}
	defer rows.Close()
	out := []AIToolPolicy{}
	for rows.Next() {
		var r AIToolPolicy
		if err := rows.Scan(&r.ToolName, &r.RiskLevel, &r.AIAllowed,
			&r.Note, &r.UpdatedBy, &r.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan policy: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetAllowedAITools returns the set of tool names the assistant is
// currently authorized to call. The SSE handler uses this to filter
// the toolspec before sending it to the LLM — disallowed tools never
// appear in the model's menu, so it physically cannot choose them.
//
// Returned as a map for O(1) lookup; size is always small (~10 tools).
func (p *PG) GetAllowedAITools(ctx context.Context) (map[string]struct{}, error) {
	rows, err := p.Pool.Query(ctx,
		`SELECT tool_name FROM ai_tool_policies WHERE ai_allowed = TRUE`)
	if err != nil {
		return nil, fmt.Errorf("allowed ai tools: %w", err)
	}
	defer rows.Close()
	out := map[string]struct{}{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		out[name] = struct{}{}
	}
	return out, rows.Err()
}

// UpsertAIToolPolicy writes the policy row. RiskLevel is stamped from
// the registered tool's code-side classification — callers can't lie
// about a write tool being "read" just to flip ai_allowed without
// realising the impact. AIAllowed and Note are the caller's truth.
func (p *PG) UpsertAIToolPolicy(ctx context.Context, row AIToolPolicy) error {
	if row.ToolName == "" {
		return fmt.Errorf("tool_name is required")
	}
	if row.RiskLevel != "read" && row.RiskLevel != "write" && row.RiskLevel != "destructive" {
		return fmt.Errorf("risk_level must be read/write/destructive, got %q", row.RiskLevel)
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO ai_tool_policies (tool_name, risk_level, ai_allowed, note, updated_by, updated_at)
		VALUES ($1,$2,$3,$4,$5,NOW())
		ON CONFLICT (tool_name) DO UPDATE SET
		  risk_level = EXCLUDED.risk_level,
		  ai_allowed = EXCLUDED.ai_allowed,
		  note = EXCLUDED.note,
		  updated_by = EXCLUDED.updated_by,
		  updated_at = NOW()`,
		row.ToolName, row.RiskLevel, row.AIAllowed, row.Note, row.UpdatedBy)
	if err != nil {
		return fmt.Errorf("upsert ai tool policy: %w", err)
	}
	return nil
}

// SyncAIToolPolicies registers any tools the running binary knows
// about that aren't yet in the table. Existing rows keep their
// operator-edited ai_allowed / note unchanged; only risk_level is
// refreshed from the code side because that's how we enforce
// "the code is the source of truth for risk classification".
//
// Returned: number of rows inserted (new tools registered).
func (p *PG) SyncAIToolPolicies(ctx context.Context, known []AIToolPolicy) (int, error) {
	if len(known) == 0 {
		return 0, nil
	}
	inserted := 0
	for _, t := range known {
		ct, err := p.Pool.Exec(ctx, `
			INSERT INTO ai_tool_policies (tool_name, risk_level, ai_allowed, note)
			VALUES ($1,$2,$3,$4)
			ON CONFLICT (tool_name) DO UPDATE SET risk_level = EXCLUDED.risk_level`,
			t.ToolName, t.RiskLevel, t.AIAllowed, t.Note)
		if err != nil {
			return inserted, fmt.Errorf("sync %s: %w", t.ToolName, err)
		}
		if ct.RowsAffected() > 0 && t.UpdatedAt.IsZero() {
			// rough heuristic: RowsAffected==1 on a brand-new insert.
			// The UPDATE path also returns 1, but we don't distinguish
			// here — caller only uses this for a startup log line.
			inserted++
		}
	}
	return inserted, nil
}
