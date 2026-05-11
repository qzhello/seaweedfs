package aireview

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/runtime"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/skill"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// Worker is the background loop that runs AI reviews on pending tasks and,
// when configured, auto-approves the ones with a strong proceed verdict.
//
// All tunables are read from runtime.Snapshot every tick so operators can
// adjust thresholds via the Web Console without a restart.
type Worker struct {
	pg     *store.PG
	ch     *store.CH
	skills *skill.Registry
	svc    *Service
	snap   *runtime.Snapshot
	log    *zap.Logger
}

func NewWorker(pg *store.PG, ch *store.CH, skills *skill.Registry, svc *Service, snap *runtime.Snapshot, log *zap.Logger) *Worker {
	return &Worker{pg: pg, ch: ch, skills: skills, svc: svc, snap: snap, log: log}
}

// Run blocks until ctx is cancelled, ticking once per configured interval.
func (w *Worker) Run(ctx context.Context) {
	w.log.Info("ai review worker started")
	for {
		interval := time.Duration(w.snap.Int("ai_review.worker_interval_seconds", 60)) * time.Second
		if interval < 10*time.Second {
			interval = 10 * time.Second
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			if err := w.OnePass(ctx); err != nil {
				w.log.Warn("ai review pass", zap.Error(err))
			}
		}
	}
}

// OnePass scans pending tasks, runs review for those without one, and
// auto-approves where the policy permits.
func (w *Worker) OnePass(ctx context.Context) error {
	pending, err := w.pg.ListTasks(ctx, "pending", 100)
	if err != nil {
		return fmt.Errorf("list pending: %w", err)
	}
	if len(pending) == 0 {
		return nil
	}

	autoApproveOn := w.snap.Bool("ai_review.auto_approve_enabled", false)
	minConf := w.snap.Float("ai_review.min_confidence", 0.85)
	maxRisk := strings.ToLower(w.snap.String("ai_review.max_risk_level", "medium"))
	// Cap reviews per tick so an outage that buries the queue doesn't burn
	// LLM budget all at once.
	maxPerTick := w.snap.Int("ai_review.max_per_tick", 5)
	if maxPerTick < 1 {
		maxPerTick = 1
	}
	reviewed := 0

	for _, t := range pending {
		if err := ctx.Err(); err != nil {
			return err
		}
		// Skip tasks that already have a complete review.
		if existing, _, err := w.pg.GetReviewWithRounds(ctx, t.ID); err == nil && existing != nil {
			if existing.Status == "complete" || existing.Status == "running" {
				if autoApproveOn && existing.Status == "complete" {
					w.tryAutoApprove(ctx, t, existing, minConf, maxRisk)
				}
				continue
			}
		}

		if reviewed >= maxPerTick {
			return nil
		}
		reviewed++
		// Build inputs from CH + task and kick off a review.
		inputs := w.buildInputs(ctx, t)
		_, _, err := w.svc.Run(ctx, inputs)
		if err != nil {
			w.log.Debug("review run failed", zap.String("task", t.ID.String()), zap.Error(err))
			continue
		}
		// Re-fetch and try to auto-approve in the same pass.
		if autoApproveOn {
			if review, _, ferr := w.pg.GetReviewWithRounds(ctx, t.ID); ferr == nil {
				w.tryAutoApprove(ctx, t, review, minConf, maxRisk)
			}
		}
	}
	return nil
}

// tryAutoApprove applies the policy and, if all gates pass, sets the task
// status to 'approved' with approved_by='ai-auto'. Audited via audit_log.
func (w *Worker) tryAutoApprove(ctx context.Context, t store.Task, review *store.AIReview, minConf float64, maxRisk string) {
	// Verdict gate.
	if review.Verdict == nil || *review.Verdict != string(VerdictProceed) {
		return
	}
	// Confidence gate.
	if review.Confidence == nil || *review.Confidence < minConf {
		return
	}
	// Risk-level gate (skill-driven).
	skillKey := actionToSkillKey(t.Action)
	if skillKey != "" && w.skills != nil {
		if loaded := w.skills.Get(skillKey); loaded != nil {
			if !riskAllowed(loaded.Row.RiskLevel, maxRisk) {
				return
			}
		}
	}
	// Final gate: never auto-approve a non-pending task (race protection).
	if t.Status != "pending" {
		return
	}

	if err := w.pg.UpdateTaskStatus(ctx, t.ID, "approved", "ai-auto"); err != nil {
		w.log.Warn("auto-approve update", zap.String("task", t.ID.String()), zap.Error(err))
		return
	}
	confStr := "?"
	if review.Confidence != nil {
		confStr = fmt.Sprintf("%.2f", *review.Confidence)
	}
	w.log.Info("ai auto-approved task",
		zap.String("task", t.ID.String()),
		zap.String("confidence", confStr),
		zap.String("review", review.ID.String()))

	// Audit row — best-effort, never blocks the approve.
	meta, _ := json.Marshal(map[string]any{
		"review_id":  review.ID,
		"verdict":    review.Verdict,
		"confidence": review.Confidence,
		"min_conf":   minConf,
		"max_risk":   maxRisk,
	})
	_, _ = w.pg.Pool.Exec(ctx,
		`INSERT INTO audit_log (actor, action, target_kind, target_id, payload)
		 VALUES ('ai-auto', 'ai_auto_approve', 'task', $1, $2)`,
		t.ID.String(), meta)
}

func (w *Worker) buildInputs(ctx context.Context, t store.Task) Inputs {
	in := Inputs{
		TaskID:      t.ID,
		VolumeID:    uint32(t.VolumeID),
		Collection:  t.Collection,
		Action:      t.Action,
		Score:       t.Score,
		Explanation: t.Explanation,
		Features:    map[string]float64{},
	}
	if len(t.Features) > 0 {
		_ = json.Unmarshal(t.Features, &in.Features)
	}
	if pat, err := w.ch.LatestPattern(ctx, uint32(t.VolumeID)); err == nil {
		in.BusinessDomain = pat.BusinessDomain
		in.PatternContext = fmt.Sprintf("cycle=%s acf24=%.2f acf168=%.2f z=%.2f",
			pat.CycleKind, pat.ACF24h, pat.ACF168h, pat.CohortZReads)
		in.CohortContext = fmt.Sprintf("domain=%s reads_7d=%d reads_per_byte=%.3e",
			pat.BusinessDomain, pat.Reads7d, pat.ReadsPerByte7d)
	}
	if w.skills != nil {
		if key := actionToSkillKey(t.Action); key != "" {
			if loaded := w.skills.Get(key); loaded != nil {
				in.Risk = loaded.Row.RiskLevel
			}
		}
	}
	return in
}

// actionToSkillKey mirrors the mapping in internal/executor — kept here as a
// local copy to avoid a circular import (executor depends on skill, this
// package depends on store and runtime only).
func actionToSkillKey(action string) string {
	switch action {
	case "tier_upload":
		return "volume.tier_upload"
	case "tier_download":
		return "volume.tier_download"
	case "ec_encode":
		return "volume.ec_encode"
	case "ec_decode":
		return "volume.ec_decode"
	case "delete_replica":
		return "volume.delete_replica"
	case "balance":
		return "volume.balance"
	case "shrink":
		return "volume.shrink"
	case "fix_replication":
		return "volume.fix_replication"
	case "vacuum":
		return "volume.vacuum"
	case "fsck":
		return "volume.fsck"
	case "collection_move":
		return "collection.move"
	case "failover_check":
		return "cluster.failover_check"
	}
	return ""
}

// riskAllowed reports whether `level` is at-or-below `cap`. Order:
// low < medium < high < critical. high/critical always require human approval
// regardless of operator config.
func riskAllowed(level, cap string) bool {
	rank := map[string]int{"low": 1, "medium": 2, "high": 3, "critical": 4}
	if rank[level] >= rank["high"] {
		return false
	}
	if rank[level] == 0 || rank[cap] == 0 {
		return false
	}
	return rank[level] <= rank[cap]
}
