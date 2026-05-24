package store

// AI S3 circuit-breaker limit proposals — see migration 041 for schema
// rationale. Mirrors the lifecycle of ai_s3_proposals (insert at AI
// emit, update at operator decision) but with a different payload
// (type/value pair instead of actions/buckets).

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

type AIS3LimitProposal struct {
	ID              uuid.UUID       `json:"id"`
	ClusterID       uuid.UUID       `json:"cluster_id"`
	CreatedAt       time.Time       `json:"created_at"`
	CreatedBy       string          `json:"created_by"`
	ProviderName    string          `json:"provider_name"`
	Snapshot        json.RawMessage `json:"snapshot"`
	ProposalType    string          `json:"proposal_type"` // "Count" | "MB"
	ProposalValue   int64           `json:"proposal_value"`
	ProposalRisk    string          `json:"proposal_risk"` // "low" | "medium" | "high"
	ProposalExplain string          `json:"proposal_explain"`

	Decision     *string    `json:"decision,omitempty"`
	DecidedAt    *time.Time `json:"decided_at,omitempty"`
	DecidedBy    *string    `json:"decided_by,omitempty"`
	AppliedType  *string    `json:"applied_type,omitempty"`
	AppliedValue *int64     `json:"applied_value,omitempty"`
}

// CreateAIS3LimitProposal persists a fresh proposal and returns its id.
// snapshot is the JSON the AI was shown — stored verbatim for audit.
func (p *PG) CreateAIS3LimitProposal(ctx context.Context, in AIS3LimitProposal) (uuid.UUID, error) {
	snap := []byte(in.Snapshot)
	if len(snap) == 0 {
		snap = []byte("{}")
	}
	var id uuid.UUID
	err := p.Pool.QueryRow(ctx, `
		INSERT INTO ai_s3_limit_proposals
		  (cluster_id, created_by, provider_name, snapshot,
		   proposal_type, proposal_value, proposal_risk, proposal_explain)
		VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)
		RETURNING id`,
		in.ClusterID, in.CreatedBy, in.ProviderName, string(snap),
		in.ProposalType, in.ProposalValue, in.ProposalRisk, in.ProposalExplain,
	).Scan(&id)
	if err != nil {
		return uuid.Nil, fmt.Errorf("insert ai_s3_limit_proposal: %w", err)
	}
	return id, nil
}

type AIS3LimitProposalDecision struct {
	Decision     string // approved | discarded | edited
	DecidedBy    string
	AppliedType  string // only meaningful when decision != discarded
	AppliedValue int64
}

// DecideAIS3LimitProposal mirrors DecideAIS3Proposal — records the
// operator's verdict (approved as-is / approved with tweak / rejected).
func (p *PG) DecideAIS3LimitProposal(ctx context.Context, id uuid.UUID, d AIS3LimitProposalDecision) error {
	if d.Decision != "approved" && d.Decision != "discarded" && d.Decision != "edited" {
		return fmt.Errorf("invalid decision %q", d.Decision)
	}
	var applType, applVal any
	if d.Decision != "discarded" {
		if d.AppliedType != "Count" && d.AppliedType != "MB" {
			return fmt.Errorf("invalid applied_type %q", d.AppliedType)
		}
		applType = d.AppliedType
		applVal = d.AppliedValue
	}
	tag, err := p.Pool.Exec(ctx, `
		UPDATE ai_s3_limit_proposals
		   SET decision      = $2,
		       decided_at    = NOW(),
		       decided_by    = $3,
		       applied_type  = $4,
		       applied_value = $5
		 WHERE id = $1`,
		id, d.Decision, d.DecidedBy, applType, applVal,
	)
	if err != nil {
		return fmt.Errorf("update ai_s3_limit_proposal: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("ai_s3_limit_proposal %s not found", id)
	}
	return nil
}

type AIS3LimitLearningSummary struct {
	Hours         int           `json:"hours"`
	Total         int           `json:"total"`
	Approved      int           `json:"approved"`
	Edited        int           `json:"edited"`
	Discarded     int           `json:"discarded"`
	AcceptRate    float64       `json:"accept_rate"`
	PrecisionRate float64       `json:"precision_rate"`
	OpenProposals int           `json:"open_proposals"`
	ByRisk        []AIS3RiskRow `json:"by_risk"` // reuses the same row shape
}

// AIS3LimitLearningInWindow aggregates settled limit proposals over
// the last N hours. Shape mirrors AIS3LearningInWindow so the
// frontend can render them with a near-identical card.
func (p *PG) AIS3LimitLearningInWindow(ctx context.Context, hours int) (AIS3LimitLearningSummary, error) {
	if hours <= 0 {
		hours = 168
	}
	if hours > 24*90 {
		hours = 24 * 90
	}
	out := AIS3LimitLearningSummary{Hours: hours}
	window := fmt.Sprintf("%d hours", hours)

	if err := p.Pool.QueryRow(ctx, `
		SELECT
		  COUNT(*) FILTER (WHERE decided_at IS NOT NULL),
		  COUNT(*) FILTER (WHERE decision = 'approved'),
		  COUNT(*) FILTER (WHERE decision = 'edited'),
		  COUNT(*) FILTER (WHERE decision = 'discarded'),
		  COUNT(*) FILTER (WHERE decided_at IS NULL AND created_at > NOW() - $1::interval)
		FROM ai_s3_limit_proposals
		WHERE created_at > NOW() - $1::interval`,
		window,
	).Scan(&out.Total, &out.Approved, &out.Edited, &out.Discarded, &out.OpenProposals); err != nil {
		return out, fmt.Errorf("ai_s3_limit_proposals summary: %w", err)
	}
	if out.Total > 0 {
		out.AcceptRate = float64(out.Approved+out.Edited) / float64(out.Total)
		out.PrecisionRate = float64(out.Approved) / float64(out.Total)
	}

	rows, err := p.Pool.Query(ctx, `
		SELECT proposal_risk,
		       COUNT(*) FILTER (WHERE decided_at IS NOT NULL),
		       COUNT(*) FILTER (WHERE decision IN ('approved','edited'))
		FROM ai_s3_limit_proposals
		WHERE created_at > NOW() - $1::interval
		GROUP BY proposal_risk
		ORDER BY proposal_risk`,
		window,
	)
	if err != nil {
		return out, fmt.Errorf("ai_s3_limit_proposals by_risk: %w", err)
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
