package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// AIReviewOutcome is one labeled observation. Created by the labeler service
// after the configured observation_hours has elapsed since task completion.
type AIReviewOutcome struct {
	ID               uuid.UUID `json:"id"`
	ReviewID         uuid.UUID `json:"review_id"`
	TaskID           uuid.UUID `json:"task_id"`
	ObservationHours int       `json:"observation_hours"`
	Verdict          string    `json:"verdict"`
	Confidence       *float64  `json:"confidence,omitempty"`
	WasCorrect       bool      `json:"was_correct"`
	Evidence         string    `json:"evidence"`
	ReadsAfter       *int64    `json:"reads_after,omitempty"`
	BytesAfter       *int64    `json:"bytes_after,omitempty"`
	ReWarmed         *bool     `json:"re_warmed,omitempty"`
	AbortWasSafe     *bool     `json:"abort_was_safe,omitempty"`
	BusinessDomain   string    `json:"business_domain"`
	ProviderName     string    `json:"provider_name"`
	CreatedAt        time.Time `json:"created_at"`
}

// LabelCandidate is the join the labeler scans every cycle: a finished task
// whose review hasn't been labeled at the requested observation window yet.
type LabelCandidate struct {
	TaskID         uuid.UUID
	VolumeID       int32
	ReviewID       uuid.UUID
	Verdict        string
	Confidence     *float64
	ProviderName   string
	BusinessDomain string
	FinishedAt     time.Time
}

// FindLabelCandidates returns tasks whose execution finished at least
// observation_hours ago AND whose review has no outcome row for that window.
//
// We deliberately keep the SQL simple: NOT EXISTS instead of LEFT JOIN, so
// the planner has an easy time when the outcomes table grows large.
func (p *PG) FindLabelCandidates(ctx context.Context, observationHours, limit int) ([]LabelCandidate, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT t.id, t.volume_id, ar.id, ar.verdict, ar.confidence, ar.provider_name,
		       e.finished_at
		FROM tasks t
		JOIN ai_reviews ar ON ar.task_id = t.id AND ar.status = 'complete'
		JOIN executions e  ON e.task_id  = t.id AND e.finished_at IS NOT NULL
		WHERE e.finished_at < now() - ($1::int * interval '1 hour')
		  AND ar.verdict IS NOT NULL
		  AND NOT EXISTS (
		    SELECT 1 FROM ai_review_outcomes o
		    WHERE o.review_id = ar.id AND o.observation_hours = $1
		  )
		ORDER BY e.finished_at DESC
		LIMIT $2`, observationHours, limit)
	if err != nil {
		return nil, fmt.Errorf("find label candidates: %w", err)
	}
	defer rows.Close()
	out := []LabelCandidate{}
	for rows.Next() {
		var lc LabelCandidate
		var verdict *string
		if err := rows.Scan(&lc.TaskID, &lc.VolumeID, &lc.ReviewID, &verdict,
			&lc.Confidence, &lc.ProviderName, &lc.FinishedAt); err != nil {
			return nil, fmt.Errorf("scan candidate: %w", err)
		}
		if verdict != nil {
			lc.Verdict = *verdict
		}
		out = append(out, lc)
	}
	return out, rows.Err()
}

func (p *PG) InsertAIOutcome(ctx context.Context, o AIReviewOutcome) error {
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO ai_review_outcomes
		  (review_id, task_id, observation_hours, verdict, confidence,
		   was_correct, evidence, reads_after, bytes_after, re_warmed,
		   abort_was_safe, business_domain, provider_name)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		ON CONFLICT (review_id, observation_hours) DO NOTHING`,
		o.ReviewID, o.TaskID, o.ObservationHours, o.Verdict, o.Confidence,
		o.WasCorrect, o.Evidence, o.ReadsAfter, o.BytesAfter, o.ReWarmed,
		o.AbortWasSafe, o.BusinessDomain, o.ProviderName)
	if err != nil {
		return fmt.Errorf("insert outcome: %w", err)
	}
	return nil
}

// AccuracySummary aggregates outcomes for the dashboard. One row per
// (verdict, provider) at the requested observation horizon.
type AccuracySummary struct {
	Verdict       string  `json:"verdict"`
	ProviderName  string  `json:"provider_name"`
	Total         int     `json:"total"`
	Correct       int     `json:"correct"`
	AccuracyRate  float64 `json:"accuracy_rate"`
	AvgConfidence float64 `json:"avg_confidence"`
}

func (p *PG) AccuracyByProvider(ctx context.Context, hours int) ([]AccuracySummary, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT verdict, provider_name,
		       COUNT(*) AS total,
		       COUNT(*) FILTER (WHERE was_correct) AS correct,
		       COALESCE(AVG(confidence), 0) AS avg_conf
		FROM ai_review_outcomes
		WHERE observation_hours = $1
		GROUP BY verdict, provider_name
		ORDER BY verdict, provider_name`, hours)
	if err != nil {
		return nil, fmt.Errorf("accuracy by provider: %w", err)
	}
	defer rows.Close()
	out := []AccuracySummary{}
	for rows.Next() {
		var s AccuracySummary
		if err := rows.Scan(&s.Verdict, &s.ProviderName, &s.Total, &s.Correct, &s.AvgConfidence); err != nil {
			return nil, fmt.Errorf("scan accuracy: %w", err)
		}
		if s.Total > 0 {
			s.AccuracyRate = float64(s.Correct) / float64(s.Total)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// AccuracyByDomainRow is the per-(verdict, domain) summary used by the
// learning dashboard to spot domains where AI judgment is weakest.
type AccuracyByDomainRow struct {
	Verdict        string  `json:"verdict"`
	BusinessDomain string  `json:"business_domain"`
	Total          int     `json:"total"`
	Correct        int     `json:"correct"`
	AccuracyRate   float64 `json:"accuracy_rate"`
	AvgConfidence  float64 `json:"avg_confidence"`
}

func (p *PG) AccuracyByDomain(ctx context.Context, hours int) ([]AccuracyByDomainRow, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT verdict, COALESCE(business_domain,'unknown') AS dom,
		       COUNT(*) AS total,
		       COUNT(*) FILTER (WHERE was_correct) AS correct,
		       COALESCE(AVG(confidence), 0) AS avg_conf
		FROM ai_review_outcomes
		WHERE observation_hours = $1
		GROUP BY verdict, dom
		ORDER BY dom, verdict`, hours)
	if err != nil {
		return nil, fmt.Errorf("accuracy by domain: %w", err)
	}
	defer rows.Close()
	out := []AccuracyByDomainRow{}
	for rows.Next() {
		var s AccuracyByDomainRow
		if err := rows.Scan(&s.Verdict, &s.BusinessDomain, &s.Total, &s.Correct, &s.AvgConfidence); err != nil {
			return nil, err
		}
		if s.Total > 0 {
			s.AccuracyRate = float64(s.Correct) / float64(s.Total)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// RecentOutcomes lists the latest N labeled outcomes for a feed view.
func (p *PG) RecentOutcomes(ctx context.Context, limit int) ([]AIReviewOutcome, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT id, review_id, task_id, observation_hours, verdict, confidence,
		       was_correct, evidence, reads_after, bytes_after, re_warmed,
		       abort_was_safe, COALESCE(business_domain,''), COALESCE(provider_name,''), created_at
		FROM ai_review_outcomes
		ORDER BY created_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("recent outcomes: %w", err)
	}
	defer rows.Close()
	out := []AIReviewOutcome{}
	for rows.Next() {
		var o AIReviewOutcome
		if err := rows.Scan(&o.ID, &o.ReviewID, &o.TaskID, &o.ObservationHours,
			&o.Verdict, &o.Confidence, &o.WasCorrect, &o.Evidence,
			&o.ReadsAfter, &o.BytesAfter, &o.ReWarmed, &o.AbortWasSafe,
			&o.BusinessDomain, &o.ProviderName, &o.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}
