package autonomy

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/aireview"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/pressure"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/runtime"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/skill"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// Pipeline runs the configured stages for one task. It does NOT execute the
// task itself — that happens later via the normal dispatcher path. The
// pipeline decides whether the task should advance from pending → approved
// (auto), stay pending (needs human), or be flagged as blocked.
//
// Pre-execute-check is run from inside the executor (see executor.RunHook)
// rather than here, because it needs the latest pressure/state at the
// moment of execution, not at score time.
type Pipeline struct {
	pg       *store.PG
	rt       *runtime.Snapshot
	skills   *skill.Registry
	press    *pressure.Snapshot
	review   *aireview.Service
	log      *zap.Logger
}

func NewPipeline(pg *store.PG, rt *runtime.Snapshot, skills *skill.Registry,
	press *pressure.Snapshot, review *aireview.Service, log *zap.Logger) *Pipeline {
	return &Pipeline{pg: pg, rt: rt, skills: skills, press: press, review: review, log: log}
}

// Result is what Decide returns to the caller (worker / API handler).
type Result struct {
	Verdict    Verdict
	Score      Score
	NextStatus string // tasks.status the caller should set (approved | pending)
}

// Decide computes the score, persists it + a pipeline_run row for each
// stage, and returns the decision. Idempotent — safe to call again if the
// task hasn't moved.
func (p *Pipeline) Decide(ctx context.Context, task store.Task) (Result, error) {
	cfg := LoadConfig(p.rt)

	// ---- Stage 1: compute_autonomy ----
	stageStart := time.Now()
	skillKey := skillKeyForAction(task.Action)
	var loaded *skill.Loaded
	if p.skills != nil && skillKey != "" {
		loaded = p.skills.Get(skillKey)
	}

	var press *pressure.Score
	if task.ClusterID != nil && p.press != nil {
		if sc, ok := p.press.Get(*task.ClusterID); ok {
			press = &sc
		}
	}

	in := Inputs{
		Task:     task,
		Skill:    loaded,
		Pressure: press,
		OffPeak:  isOffPeak(time.Now()),
		// Frozen flag could be read from holidays table; left false for v1.
		// AIReview filled by separate stage below.
	}

	// Read latest AI review. If it's still running (or hasn't started),
	// hold off on a final decision — auto-approving before AI completes
	// risks ignoring a verdict=needs_human that's about to arrive.
	aiSummary, aiPending := p.latestAIReview(ctx, task.ID)
	if aiSummary != nil {
		// Hand blast bytes to the rebuttal engine so it can challenge
		// "high IO impact" claims with the real affected size.
		aiSummary.BlastBytes = estimateBlastBytes(task, loaded)
	}
	in.AIReview = aiSummary

	score := Calculate(ctx, in, cfg)
	if aiPending && score.Verdict == VerdictAutoProceed {
		// Demote to needs_human until AI completes; the worker will retry
		// next tick. Persist so the UI shows why nothing happened.
		score.Verdict = VerdictNeedsHuman
		score.VetoedBy = "ai_review_pending — waiting for multi-round review"
	}
	if err := PersistScore(ctx, p.pg, task.ID, score); err != nil {
		p.log.Warn("persist autonomy score", zap.Error(err))
	}
	p.recordStage(ctx, task.ID, nil, "compute_autonomy", string(score.Verdict),
		score, "", time.Since(stageStart))

	// ---- Stage 2: auto_gate ----
	stageStart = time.Now()
	switch score.Verdict {
	case VerdictAutoProceed:
		p.recordStage(ctx, task.ID, nil, "auto_gate", "pass",
			map[string]any{"score": score.Total, "threshold": score.Threshold},
			fmt.Sprintf("score %.2f ≥ threshold %.2f", score.Total, score.Threshold),
			time.Since(stageStart))
		return Result{Verdict: score.Verdict, Score: score, NextStatus: "approved"}, nil

	case VerdictBlocked:
		p.recordStage(ctx, task.ID, nil, "auto_gate", "needs_human",
			map[string]any{"reason": "high_risk_skill"},
			"skill is on autonomy.high_risk_skills; manual approval required",
			time.Since(stageStart))
		return Result{Verdict: score.Verdict, Score: score, NextStatus: "pending"}, nil

	default: // needs_human
		p.recordStage(ctx, task.ID, nil, "auto_gate", "needs_human",
			map[string]any{"score": score.Total, "threshold": score.Threshold},
			fmt.Sprintf("score %.2f < threshold %.2f", score.Total, score.Threshold),
			time.Since(stageStart))
		return Result{Verdict: score.Verdict, Score: score, NextStatus: "pending"}, nil
	}
}

// PreExecuteCheck re-evaluates the task right before the executor starts
// real work. If the world has changed (pressure spiked, cluster degraded,
// upstream skill says abort), we cancel the run. Called from executor.Run.
func (p *Pipeline) PreExecuteCheck(ctx context.Context, task store.Task, execID uuid.UUID) error {
	if !p.rt.Bool("autonomy.pre_execute_check", true) {
		return nil
	}
	stageStart := time.Now()

	// Pressure spike check: pretend the dispatcher might have admitted us
	// just before a spike; if cluster is now busy, defer.
	if task.ClusterID != nil && p.press != nil && p.press.IsBusy(*task.ClusterID) {
		sc, _ := p.press.Get(*task.ClusterID)
		ev := map[string]any{"pressure": sc.Value, "threshold": p.press.Threshold()}
		p.recordStage(ctx, task.ID, &execID, "pre_execute_check", "defer", ev,
			fmt.Sprintf("pressure %.2f ≥ threshold %.2f at execute time", sc.Value, p.press.Threshold()),
			time.Since(stageStart))
		return fmt.Errorf("pre-execute check: cluster busy (pressure=%.2f ≥ %.2f)",
			sc.Value, p.press.Threshold())
	}

	// Fast AI sanity check (single round, cheap). If the AI says abort or
	// needs_human now, veto.
	if p.review != nil {
		in := aireview.Inputs{
			TaskID: task.ID, VolumeID: uint32(task.VolumeID),
			Action: task.Action, Score: task.Score,
		}
		_, verdict, err := p.review.Run(ctx, in)
		if err == nil && verdict == aireview.VerdictAbort {
			ev := map[string]any{"verdict": string(verdict)}
			p.recordStage(ctx, task.ID, &execID, "pre_execute_check", "fail", ev,
				"AI pre-execute review verdict=abort",
				time.Since(stageStart))
			return fmt.Errorf("pre-execute check: AI verdict=abort")
		}
	}

	p.recordStage(ctx, task.ID, &execID, "pre_execute_check", "pass",
		map[string]any{},
		"all checks passed",
		time.Since(stageStart))
	return nil
}

// ---------------- helpers ----------------

func (p *Pipeline) recordStage(ctx context.Context, taskID uuid.UUID, execID *uuid.UUID,
	stage, decision string, evidence any, reason string, dur time.Duration) {
	ev, _ := json.Marshal(evidence)
	durMs := int(dur / time.Millisecond)
	now := time.Now()
	_, err := p.pg.InsertPipelineRun(ctx, store.PipelineRun{
		TaskID: taskID, ExecutionID: execID,
		Stage: stage, Decision: decision, Evidence: ev,
		Reason: reason, DurationMs: &durMs,
		StartedAt: now.Add(-dur), FinishedAt: &now,
	})
	if err != nil {
		p.log.Warn("record pipeline stage", zap.String("stage", stage), zap.Error(err))
	}
}

// latestAIReview returns the aggregated verdict of the most recent multi-
// round review for a task. Returns nil in two cases that callers must
// distinguish:
//
//   - review row doesn't exist yet (AI worker hasn't run) → autonomy worker
//     should wait, not score with a null factor
//   - review row exists but is still running → ditto
//
// The reviewPending out-param is true in both cases. Callers should defer
// auto-approval until the AI review settles, otherwise a high score from
// the other 4 factors can auto-approve a task that AI would have vetoed.
func (p *Pipeline) latestAIReview(ctx context.Context, taskID uuid.UUID) (summary *AIReviewSummary, reviewPending bool) {
	review, rounds, err := p.pg.GetReviewWithRounds(ctx, taskID)
	if err != nil || review == nil {
		return nil, true // never started → wait
	}
	if review.Status == "running" || review.Verdict == nil {
		return nil, true // in flight → wait
	}
	okCount := 0
	// Collect factors from non-proceed rounds — these are the concerns
	// the rebuttal engine will challenge. JSON-array-merged into one
	// blob so the rebutter can iterate without re-reading PG.
	var allFactors []json.RawMessage
	for _, r := range rounds {
		if r.Verdict != nil && *r.Verdict == "proceed" {
			okCount++
			continue
		}
		if len(r.Factors) > 0 {
			// `factors` is itself an array; unmarshal then re-marshal.
			var inner []json.RawMessage
			if json.Unmarshal(r.Factors, &inner) == nil {
				allFactors = append(allFactors, inner...)
			}
		}
	}
	conf := 0.0
	if review.Confidence != nil {
		conf = *review.Confidence
	}
	factorsBlob, _ := json.Marshal(allFactors)
	return &AIReviewSummary{
		Verdict:     *review.Verdict,
		Confidence:  conf,
		RoundsOK:    okCount,
		Rounds:      len(rounds),
		FactorsJSON: factorsBlob,
	}, false
}

// skillKeyForAction mirrors executor.actionToSkill (duplicated to avoid an
// executor → autonomy → executor import cycle).
func skillKeyForAction(action string) string {
	switch action {
	case "tier_upload":
		return "volume.tier_upload"
	case "tier_download":
		return "volume.tier_download"
	case "tier_move":
		return "volume.tier_move"
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

// isOffPeak is a deliberately simple "is it late night" check. The Sprint 4
// holidays module owns the proper change-window logic; this can be wired
// here later. For now: hours 23-06 in the controller's local time qualify.
func isOffPeak(t time.Time) bool {
	h := t.Hour()
	return h >= 23 || h < 6
}

// asDecisionString stringifies Verdict for the pipeline_runs.decision column.
func asDecisionString(v Verdict) string {
	return strings.ToLower(string(v))
}
