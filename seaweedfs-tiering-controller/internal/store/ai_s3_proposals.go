package store

// AI S3 policy proposals — see migration 040 for the schema rationale.
//
// Lifecycle: insert one row when the NL → IAM endpoint returns a
// proposal, then update the same row when the operator approves /
// discards / edits. The decision side of the row stays NULL until the
// operator acts; that lets us count "open" proposals (UI nudge to
// resolve them) separately from "settled" proposals (input to the
// learning summary).

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// AIS3Proposal is one row in ai_s3_proposals. Pointer fields are NULL
// until the operator decides.
type AIS3Proposal struct {
	ID              uuid.UUID `json:"id"`
	ClusterID       uuid.UUID `json:"cluster_id"`
	CreatedAt       time.Time `json:"created_at"`
	CreatedBy       string    `json:"created_by"`
	ProviderName    string    `json:"provider_name"`
	Prompt          string    `json:"prompt"`
	ScopeHint       string    `json:"scope_hint"`
	ProposalActions []string  `json:"proposal_actions"`
	ProposalBuckets []string  `json:"proposal_buckets"`
	ProposalRisk    string    `json:"proposal_risk"`
	ProposalExplain string    `json:"proposal_explain"`

	Decision       *string    `json:"decision,omitempty"`
	DecidedAt      *time.Time `json:"decided_at,omitempty"`
	DecidedBy      *string    `json:"decided_by,omitempty"`
	AppliedActions []string   `json:"applied_actions,omitempty"`
	AppliedBuckets []string   `json:"applied_buckets,omitempty"`
	AppliedUser    *string    `json:"applied_user,omitempty"`
}

// CreateAIS3Proposal persists a fresh proposal and returns its id.
func (p *PG) CreateAIS3Proposal(ctx context.Context, in AIS3Proposal) (uuid.UUID, error) {
	actions, _ := json.Marshal(in.ProposalActions)
	buckets, _ := json.Marshal(in.ProposalBuckets)
	var id uuid.UUID
	err := p.Pool.QueryRow(ctx, `
		INSERT INTO ai_s3_proposals
		  (cluster_id, created_by, provider_name, prompt, scope_hint,
		   proposal_actions, proposal_buckets, proposal_risk, proposal_explain)
		VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)
		RETURNING id`,
		in.ClusterID, in.CreatedBy, in.ProviderName, in.Prompt, in.ScopeHint,
		string(actions), string(buckets), in.ProposalRisk, in.ProposalExplain,
	).Scan(&id)
	if err != nil {
		return uuid.Nil, fmt.Errorf("insert ai_s3_proposal: %w", err)
	}
	return id, nil
}

// AIS3ProposalDecision is the operator's verdict on a proposal.
type AIS3ProposalDecision struct {
	Decision       string // approved | discarded | edited
	DecidedBy      string
	AppliedActions []string // only meaningful when decision != discarded
	AppliedBuckets []string
	AppliedUser    string
}

// DecideAIS3Proposal updates the decision side of one proposal. Idempotent
// in the sense that re-deciding overwrites the prior decision (useful when
// the operator clicks Approve after a Discard by mistake).
func (p *PG) DecideAIS3Proposal(ctx context.Context, id uuid.UUID, d AIS3ProposalDecision) error {
	if d.Decision != "approved" && d.Decision != "discarded" && d.Decision != "edited" {
		return fmt.Errorf("invalid decision %q", d.Decision)
	}
	// Use Go nil + pgx's automatic null handling: marshal to JSON when
	// the decision implies applied data, otherwise pass nil to write SQL NULL.
	var actionsJSON, bucketsJSON any
	if d.Decision != "discarded" {
		a, _ := json.Marshal(d.AppliedActions)
		b, _ := json.Marshal(d.AppliedBuckets)
		actionsJSON = string(a)
		bucketsJSON = string(b)
	}
	var appliedUser any
	if d.AppliedUser != "" {
		appliedUser = d.AppliedUser
	}
	tag, err := p.Pool.Exec(ctx, `
		UPDATE ai_s3_proposals
		   SET decision        = $2,
		       decided_at      = NOW(),
		       decided_by      = $3,
		       applied_actions = $4::jsonb,
		       applied_buckets = $5::jsonb,
		       applied_user    = $6
		 WHERE id = $1`,
		id, d.Decision, d.DecidedBy, actionsJSON, bucketsJSON, appliedUser,
	)
	if err != nil {
		return fmt.Errorf("update ai_s3_proposal: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("ai_s3_proposal %s not found", id)
	}
	return nil
}

// AIS3LearningSummary aggregates settled proposals over the last N hours.
// Surfaced on the AI Learning panel beside the task verdict accuracy.
type AIS3LearningSummary struct {
	Hours         int           `json:"hours"`
	Total         int           `json:"total"` // settled (decided_at IS NOT NULL)
	Approved      int           `json:"approved"`
	Edited        int           `json:"edited"`
	Discarded     int           `json:"discarded"`
	AcceptRate    float64       `json:"accept_rate"`    // (approved+edited)/total
	PrecisionRate float64       `json:"precision_rate"` // approved/total
	OpenProposals int           `json:"open_proposals"` // decided_at IS NULL
	ByRisk        []AIS3RiskRow `json:"by_risk"`
}

type AIS3RiskRow struct {
	Risk       string  `json:"risk"`
	Total      int     `json:"total"`
	Approved   int     `json:"approved"`
	AcceptRate float64 `json:"accept_rate"`
}

// AIS3LearningInWindow returns aggregated metrics for the AI Learning panel.
// hours is clamped so the partial index stays usable.
func (p *PG) AIS3LearningInWindow(ctx context.Context, hours int) (AIS3LearningSummary, error) {
	if hours <= 0 {
		hours = 168 // 7 days default
	}
	if hours > 24*90 {
		hours = 24 * 90
	}
	out := AIS3LearningSummary{Hours: hours}
	window := fmt.Sprintf("%d hours", hours)

	if err := p.Pool.QueryRow(ctx, `
		SELECT
		  COUNT(*) FILTER (WHERE decided_at IS NOT NULL)                                  AS total,
		  COUNT(*) FILTER (WHERE decision = 'approved')                                   AS approved,
		  COUNT(*) FILTER (WHERE decision = 'edited')                                     AS edited,
		  COUNT(*) FILTER (WHERE decision = 'discarded')                                  AS discarded,
		  COUNT(*) FILTER (WHERE decided_at IS NULL AND created_at > NOW() - $1::interval) AS open
		FROM ai_s3_proposals
		WHERE created_at > NOW() - $1::interval`,
		window,
	).Scan(&out.Total, &out.Approved, &out.Edited, &out.Discarded, &out.OpenProposals); err != nil {
		return out, fmt.Errorf("ai_s3_proposals summary: %w", err)
	}
	if out.Total > 0 {
		out.AcceptRate = float64(out.Approved+out.Edited) / float64(out.Total)
		out.PrecisionRate = float64(out.Approved) / float64(out.Total)
	}

	rows, err := p.Pool.Query(ctx, `
		SELECT proposal_risk,
		       COUNT(*) FILTER (WHERE decided_at IS NOT NULL) AS total,
		       COUNT(*) FILTER (WHERE decision IN ('approved','edited')) AS approved
		FROM ai_s3_proposals
		WHERE created_at > NOW() - $1::interval
		GROUP BY proposal_risk
		ORDER BY proposal_risk`,
		window,
	)
	if err != nil {
		return out, fmt.Errorf("ai_s3_proposals by_risk: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var r AIS3RiskRow
		if err := rows.Scan(&r.Risk, &r.Total, &r.Approved); err != nil {
			return out, fmt.Errorf("scan by_risk: %w", err)
		}
		if r.Total > 0 {
			r.AcceptRate = float64(r.Approved) / float64(r.Total)
		}
		out.ByRisk = append(out.ByRisk, r)
	}
	return out, rows.Err()
}
