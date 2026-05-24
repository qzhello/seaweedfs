package store

// AI bucket-level cost proposals — see migration 042 for schema
// rationale. Same insert-then-decide lifecycle as ai_s3_proposals
// (040) and ai_s3_limit_proposals (041); the payload differs because
// the action set is bucket-shaped, not volume- or limit-shaped.

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

type AIBucketCostProposal struct {
	ID               uuid.UUID       `json:"id"`
	ClusterID        uuid.UUID       `json:"cluster_id"`
	CreatedAt        time.Time       `json:"created_at"`
	CreatedBy        string          `json:"created_by"`
	ProviderName     string          `json:"provider_name"`
	Snapshot         json.RawMessage `json:"snapshot"`
	Bucket           string          `json:"bucket"`
	ProposalAction   string          `json:"proposal_action"` // set_quota | cleanup_uploads | review_for_deletion | investigate_tiering
	ProposalValue    json.RawMessage `json:"proposal_value"`  // action-specific JSON payload
	ProposalRisk     string          `json:"proposal_risk"`   // low | medium | high
	ProposalExplain  string          `json:"proposal_explain"`
	EstMonthlySaving float64         `json:"est_monthly_saving"`
	Currency         string          `json:"currency"`

	Decision     *string         `json:"decision,omitempty"`
	DecidedAt    *time.Time      `json:"decided_at,omitempty"`
	DecidedBy    *string         `json:"decided_by,omitempty"`
	AppliedValue json.RawMessage `json:"applied_value,omitempty"`
}

var validBucketActions = map[string]bool{
	"set_quota":           true,
	"cleanup_uploads":     true,
	"review_for_deletion": true,
	"investigate_tiering": true,
}

// CreateAIBucketCostProposal persists a fresh proposal and returns its id.
func (p *PG) CreateAIBucketCostProposal(ctx context.Context, in AIBucketCostProposal) (uuid.UUID, error) {
	if !validBucketActions[in.ProposalAction] {
		return uuid.Nil, fmt.Errorf("invalid bucket cost action %q", in.ProposalAction)
	}
	snap := []byte(in.Snapshot)
	if len(snap) == 0 {
		snap = []byte("{}")
	}
	val := []byte(in.ProposalValue)
	if len(val) == 0 {
		val = []byte("{}")
	}
	if in.Currency == "" {
		in.Currency = "USD"
	}
	var id uuid.UUID
	err := p.Pool.QueryRow(ctx, `
		INSERT INTO ai_bucket_cost_proposals
		  (cluster_id, created_by, provider_name, snapshot,
		   bucket, proposal_action, proposal_value,
		   proposal_risk, proposal_explain,
		   est_monthly_saving, currency)
		VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8,$9,$10,$11)
		RETURNING id`,
		in.ClusterID, in.CreatedBy, in.ProviderName, string(snap),
		in.Bucket, in.ProposalAction, string(val),
		in.ProposalRisk, in.ProposalExplain,
		in.EstMonthlySaving, in.Currency,
	).Scan(&id)
	if err != nil {
		return uuid.Nil, fmt.Errorf("insert ai_bucket_cost_proposal: %w", err)
	}
	return id, nil
}

type AIBucketCostDecision struct {
	Decision     string // approved | discarded | edited
	DecidedBy    string
	AppliedValue json.RawMessage // applied payload (may differ from proposal for "edited")
}

func (p *PG) DecideAIBucketCostProposal(ctx context.Context, id uuid.UUID, d AIBucketCostDecision) error {
	if d.Decision != "approved" && d.Decision != "discarded" && d.Decision != "edited" {
		return fmt.Errorf("invalid decision %q", d.Decision)
	}
	var applied any
	if d.Decision != "discarded" && len(d.AppliedValue) > 0 {
		applied = string(d.AppliedValue)
	}
	tag, err := p.Pool.Exec(ctx, `
		UPDATE ai_bucket_cost_proposals
		   SET decision      = $2,
		       decided_at    = NOW(),
		       decided_by    = $3,
		       applied_value = $4::jsonb
		 WHERE id = $1`,
		id, d.Decision, d.DecidedBy, applied,
	)
	if err != nil {
		return fmt.Errorf("update ai_bucket_cost_proposal: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("ai_bucket_cost_proposal %s not found", id)
	}
	return nil
}

// AIBucketCostLearningSummary reuses AIS3RiskRow for the by-risk table
// since the shape (risk | total | approved | accept_rate) is identical.
type AIBucketCostLearningSummary struct {
	Hours          int              `json:"hours"`
	Total          int              `json:"total"`
	Approved       int              `json:"approved"`
	Edited         int              `json:"edited"`
	Discarded      int              `json:"discarded"`
	AcceptRate     float64          `json:"accept_rate"`
	PrecisionRate  float64          `json:"precision_rate"`
	OpenProposals  int              `json:"open_proposals"`
	RealisedSaving float64          `json:"realised_saving"` // sum(est_monthly_saving) of approved+edited
	Currency       string           `json:"currency"`
	ByRisk         []AIS3RiskRow    `json:"by_risk"`
	ByAction       []AIBucketActRow `json:"by_action"`
}

// AIBucketActRow is the per-action breakdown surfaced in the Learning panel.
type AIBucketActRow struct {
	Action     string  `json:"action"`
	Total      int     `json:"total"`
	Approved   int     `json:"approved"`
	AcceptRate float64 `json:"accept_rate"`
}

func (p *PG) AIBucketCostLearningInWindow(ctx context.Context, hours int) (AIBucketCostLearningSummary, error) {
	if hours <= 0 {
		hours = 168
	}
	if hours > 24*90 {
		hours = 24 * 90
	}
	out := AIBucketCostLearningSummary{Hours: hours, Currency: "USD"}
	window := fmt.Sprintf("%d hours", hours)

	if err := p.Pool.QueryRow(ctx, `
		SELECT
		  COUNT(*) FILTER (WHERE decided_at IS NOT NULL),
		  COUNT(*) FILTER (WHERE decision = 'approved'),
		  COUNT(*) FILTER (WHERE decision = 'edited'),
		  COUNT(*) FILTER (WHERE decision = 'discarded'),
		  COUNT(*) FILTER (WHERE decided_at IS NULL AND created_at > NOW() - $1::interval),
		  COALESCE(SUM(est_monthly_saving) FILTER (WHERE decision IN ('approved','edited')), 0)
		FROM ai_bucket_cost_proposals
		WHERE created_at > NOW() - $1::interval`,
		window,
	).Scan(&out.Total, &out.Approved, &out.Edited, &out.Discarded, &out.OpenProposals, &out.RealisedSaving); err != nil {
		return out, fmt.Errorf("ai_bucket_cost_proposals summary: %w", err)
	}
	if out.Total > 0 {
		out.AcceptRate = float64(out.Approved+out.Edited) / float64(out.Total)
		out.PrecisionRate = float64(out.Approved) / float64(out.Total)
	}

	// By risk
	riskRows, err := p.Pool.Query(ctx, `
		SELECT proposal_risk,
		       COUNT(*) FILTER (WHERE decided_at IS NOT NULL),
		       COUNT(*) FILTER (WHERE decision IN ('approved','edited'))
		FROM ai_bucket_cost_proposals
		WHERE created_at > NOW() - $1::interval
		GROUP BY proposal_risk
		ORDER BY proposal_risk`,
		window,
	)
	if err != nil {
		return out, fmt.Errorf("ai_bucket_cost_proposals by_risk: %w", err)
	}
	defer riskRows.Close()
	for riskRows.Next() {
		var r AIS3RiskRow
		if err := riskRows.Scan(&r.Risk, &r.Total, &r.Approved); err != nil {
			return out, fmt.Errorf("scan by_risk: %w", err)
		}
		if r.Total > 0 {
			r.AcceptRate = float64(r.Approved) / float64(r.Total)
		}
		out.ByRisk = append(out.ByRisk, r)
	}
	if err := riskRows.Err(); err != nil {
		return out, err
	}

	// By action
	actRows, err := p.Pool.Query(ctx, `
		SELECT proposal_action,
		       COUNT(*) FILTER (WHERE decided_at IS NOT NULL),
		       COUNT(*) FILTER (WHERE decision IN ('approved','edited'))
		FROM ai_bucket_cost_proposals
		WHERE created_at > NOW() - $1::interval
		GROUP BY proposal_action
		ORDER BY proposal_action`,
		window,
	)
	if err != nil {
		return out, fmt.Errorf("ai_bucket_cost_proposals by_action: %w", err)
	}
	defer actRows.Close()
	for actRows.Next() {
		var r AIBucketActRow
		if err := actRows.Scan(&r.Action, &r.Total, &r.Approved); err != nil {
			return out, fmt.Errorf("scan by_action: %w", err)
		}
		if r.Total > 0 {
			r.AcceptRate = float64(r.Approved) / float64(r.Total)
		}
		out.ByAction = append(out.ByAction, r)
	}
	return out, actRows.Err()
}
