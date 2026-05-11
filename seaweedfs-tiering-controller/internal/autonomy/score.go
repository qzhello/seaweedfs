// Package autonomy decides — per task — whether the controller should run
// the action automatically or escalate to a human. The decision is a
// weighted sum of 5 factors persisted as tasks.autonomy_score JSON:
//
//	risk_level        — from the skill yaml (low=1, medium=0.5, high=0)
//	blast_radius      — affected bytes / blast_radius_bytes_full (inverted)
//	cluster_pressure  — 1 - latest pressure score
//	change_window     — off-peak=1, peak=0.5, frozen=0
//	ai_consensus      — multi-round verdict + average confidence
//
// total = Σ factor.value × factor.weight. Above autonomy.threshold (default
// 0.75) the dispatcher auto-approves; below it the task stays pending.
package autonomy

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/pressure"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/runtime"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/skill"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// Verdict is the final pipeline decision derived from the score.
type Verdict string

const (
	VerdictAutoProceed Verdict = "auto_proceed"
	VerdictNeedsHuman  Verdict = "needs_human"
	VerdictBlocked     Verdict = "blocked" // hard rule (high-risk skill, autonomy off)
)

// Factor is one column of the breakdown. Raw is what we saw, Value is
// normalized 0..1, Weight is from config, Weighted = Value × Weight.
type Factor struct {
	Raw      any     `json:"raw"`
	Value    float64 `json:"value"`
	Weight   float64 `json:"weight"`
	Weighted float64 `json:"weighted"`
	Notes    string  `json:"notes,omitempty"`
}

// Score is the full persisted breakdown.
type Score struct {
	Total      float64           `json:"total"`
	Threshold  float64           `json:"threshold"`
	Verdict    Verdict           `json:"verdict"`
	Factors    map[string]Factor `json:"factors"`
	ComputedAt time.Time         `json:"computed_at"`
	// VetoedBy names the gate that overrode an otherwise-passing score —
	// for example "ai_review_needs_human" or "high_risk_skill". Empty if
	// no veto fired. Surfaced in the UI so operators can see "score 0.93
	// would have auto-approved but AI's deep analysis vetoed".
	VetoedBy string `json:"vetoed_by,omitempty"`
	// VetoAssessment is the rebuttal of an AI veto against ground truth.
	// Populated only when an AI veto was either upheld or overridden.
	VetoAssessment *VetoAssessment `json:"veto_assessment,omitempty"`
}

// Inputs holds everything the calculator needs. Pulled by the worker so the
// score function itself stays pure-functional / testable.
type Inputs struct {
	Task      store.Task
	Skill     *skill.Loaded // nil if no skill found
	Pressure  *pressure.Score // latest pressure for the task's cluster; nil = unknown
	Frozen    bool          // holidays / change-freeze active
	OffPeak   bool          // current hour qualifies as off-peak window
	AIReview  *AIReviewSummary
}

// AIReviewSummary is the trimmed view of an existing aireview run.
type AIReviewSummary struct {
	Verdict    string  // proceed | abort | needs_human (final aggregate)
	Confidence float64 // 0..1 aggregate
	RoundsOK   int     // rounds that voted proceed
	Rounds     int     // total rounds
	// FactorsJSON is the concatenated factors[] from non-proceed rounds.
	// Fed into the rebuttal engine when the verdict is needs_human / abort
	// so autonomy can override unfounded claims.
	FactorsJSON json.RawMessage
	BlastBytes  int64 // pre-computed by caller so rebuttal can challenge IO claims
}

// Config carries runtime-driven knobs so calculation is pure of side effects.
type Config struct {
	Threshold              float64
	Weights                map[string]float64
	HighRiskSkills         map[string]struct{}
	BlastRadiusFull        int64
	AutonomyEnabled        bool
	// AIVetoOverrideStrength is the floor of "remaining unrebutted AI
	// concern" below which autonomy is allowed to override an AI
	// needs_human verdict. Default 0.5 — if ≥50% of (weighted) AI
	// concerns survive ground-truth checks, the veto stands.
	AIVetoOverrideStrength float64
}

// LoadConfig reads the live runtime snapshot into a typed Config. Missing
// keys fall back to sensible defaults.
func LoadConfig(rt *runtime.Snapshot) Config {
	c := Config{
		Threshold:              0.75,
		Weights:                map[string]float64{"risk_level": 0.30, "blast_radius": 0.20, "cluster_pressure": 0.20, "change_window": 0.10, "ai_consensus": 0.20},
		HighRiskSkills:         map[string]struct{}{},
		BlastRadiusFull:        100 * 1024 * 1024 * 1024,
		AutonomyEnabled:        true,
		AIVetoOverrideStrength: 0.5,
	}
	if rt == nil {
		return c
	}
	c.AutonomyEnabled = rt.Bool("autonomy.enabled", true)
	c.Threshold = rt.Float("autonomy.threshold", 0.75)
	if raw := rt.JSON("autonomy.weights"); len(raw) > 0 {
		var w map[string]float64
		if err := json.Unmarshal(raw, &w); err == nil && len(w) > 0 {
			c.Weights = w
		}
	}
	if raw := rt.JSON("autonomy.high_risk_skills"); len(raw) > 0 {
		var arr []string
		if err := json.Unmarshal(raw, &arr); err == nil {
			for _, s := range arr {
				c.HighRiskSkills[s] = struct{}{}
			}
		}
	}
	c.BlastRadiusFull = int64(rt.Int("autonomy.blast_radius_bytes_full", 100*1024*1024*1024))
	c.AIVetoOverrideStrength = rt.Float("autonomy.ai_veto_override_strength", 0.5)
	return c
}

// Calculate produces the Score for one task using the live config.
func Calculate(_ context.Context, in Inputs, cfg Config) Score {
	factors := map[string]Factor{
		"risk_level":       riskFactor(in.Skill),
		"blast_radius":     blastFactor(in.Task, in.Skill, cfg.BlastRadiusFull),
		"cluster_pressure": pressureFactor(in.Pressure),
		"change_window":    windowFactor(in.Frozen, in.OffPeak),
		"ai_consensus":     aiFactor(in.AIReview),
	}

	// Factors whose Raw is nil (no signal yet — e.g. AI hasn't reviewed,
	// pressure pipeline cold) get *skipped* instead of contributing a
	// pessimistic 0.5. We renormalize the surviving weights so the score
	// stays interpretable in [0,1]. This stops the autonomy gate from
	// hard-blocking new tasks just because some background pipeline lags
	// the dispatcher by a few seconds.
	totalWeight := 0.0
	for name := range factors {
		if factors[name].Raw == nil {
			continue
		}
		totalWeight += cfg.Weights[name]
	}
	if totalWeight <= 0 {
		totalWeight = 1 // avoid div-by-zero; produces score=0 → needs_human
	}

	total := 0.0
	for name, f := range factors {
		w := cfg.Weights[name]
		f.Weight = w
		if f.Raw == nil {
			// Skipped factor: keep raw breakdown for the UI but contribute 0.
			f.Weighted = 0
			factors[name] = f
			continue
		}
		// Use renormalized weight so missing-signal factors don't drag the
		// score down. effective = w / totalWeight (sums to 1 across present).
		effective := w / totalWeight
		f.Weighted = f.Value * effective
		factors[name] = f
		total += f.Weighted
	}

	verdict := VerdictNeedsHuman
	if cfg.AutonomyEnabled && total >= cfg.Threshold {
		verdict = VerdictAutoProceed
	}
	// Hard guard: high-risk skills never auto-proceed regardless of score.
	vetoedBy := ""
	if in.Skill != nil {
		if _, blocked := cfg.HighRiskSkills[in.Skill.Row.Key]; blocked {
			verdict = VerdictBlocked
			vetoedBy = "high_risk_skill"
		}
	}
	if !cfg.AutonomyEnabled {
		verdict = VerdictNeedsHuman
		vetoedBy = "autonomy_disabled"
	}
	// AI veto: when multi-round review voted abort / needs_human we'd
	// normally escalate. But the AI's reasoning is *factor-based* — if its
	// stated concerns ("peak hours", "replication storm") are contradicted
	// by ground truth (off-peak clock + cluster lock), autonomy gets to
	// rebut the veto. This stops obvious LLM hallucinations from blocking
	// trivially-safe operations.
	var assessment *VetoAssessment
	if in.AIReview != nil && verdict == VerdictAutoProceed {
		switch in.AIReview.Verdict {
		case "abort":
			verdict = VerdictBlocked
			vetoedBy = fmt.Sprintf("ai_review_abort (conf=%.2f)", in.AIReview.Confidence)

		case "needs_human":
			// Try to rebut the AI's stated reasons against measurable
			// ground truth (pressure, time-of-day, skill metadata, blast).
			skInfo := skillInfo(in.Skill)
			rebut := RebutAIClaims(in.AIReview.FactorsJSON, in.Task, skInfo, in.Pressure,
				in.AIReview.BlastBytes, time.Now(), cfg.AIVetoOverrideStrength)
			assessment = &rebut

			if rebut.Override {
				// AI's reasons mostly disproved; keep auto_proceed but
				// surface the rebuttal in vetoedBy so the operator can
				// see why we ignored the AI.
				vetoedBy = fmt.Sprintf("ai_veto_overridden (rebutted=%.0f%%, %d/%d 项被实测数据否决)",
					(1-rebut.EffectiveStrength)*100, countRebutted(rebut.Rebuttals), len(rebut.Rebuttals))
			} else {
				verdict = VerdictNeedsHuman
				vetoedBy = fmt.Sprintf("ai_review_needs_human (conf=%.2f, %d/%d rounds, AI 顾虑仍有 %.0f%% 未被实测反驳)",
					in.AIReview.Confidence, in.AIReview.RoundsOK, in.AIReview.Rounds, rebut.EffectiveStrength*100)
			}
		}
	}
	return Score{
		Total:          clamp01(total),
		Threshold:      cfg.Threshold,
		Verdict:        verdict,
		Factors:        factors,
		ComputedAt:     time.Now().UTC(),
		VetoedBy:       vetoedBy,
		VetoAssessment: assessment,
	}
}

func countRebutted(rs []Rebuttal) int {
	n := 0
	for _, r := range rs {
		if r.Rebutted {
			n++
		}
	}
	return n
}

// skillInfo extracts the bits the rebuttal engine needs from a loaded skill.
// Idempotency + cluster-lock are inferred from the JSON definition's steps.
func skillInfo(loaded any) SkillInfo {
	type stepLite struct{ Op string `json:"op"` }
	type defLite struct {
		Steps []stepLite `json:"steps"`
	}
	if loaded == nil {
		return SkillInfo{}
	}
	// Use reflection-light path: try to JSON-roundtrip from the skill.Row.
	type row struct {
		Key        string          `json:"key"`
		RiskLevel  string          `json:"risk_level"`
		Definition json.RawMessage `json:"definition"`
	}
	type loadedShape struct {
		Row row `json:"Row"`
	}
	b, err := json.Marshal(loaded)
	if err != nil {
		return SkillInfo{}
	}
	var l loadedShape
	if err := json.Unmarshal(b, &l); err != nil {
		return SkillInfo{}
	}
	info := SkillInfo{Key: l.Row.Key, RiskLevel: l.Row.RiskLevel}
	if len(l.Row.Definition) > 0 {
		var d defLite
		if err := json.Unmarshal(l.Row.Definition, &d); err == nil {
			for _, s := range d.Steps {
				if s.Op == "acquire_cluster_repair_lock" || s.Op == "acquire_cluster_balance_lock" {
					info.HoldsClusterLock = true
				}
			}
		}
	}
	// Idempotency heuristic: skills that only add replicas / are read-only.
	switch info.Key {
	case "volume.fix_replication", "volume.fsck", "volume.vacuum", "volume.balance":
		info.IsIdempotent = true
	}
	return info
}

// ---------------- factor calculators ----------------

func riskFactor(sk *skill.Loaded) Factor {
	level := "unknown"
	if sk != nil {
		level = sk.Row.RiskLevel
	}
	v := 0.5
	switch level {
	case "low":
		v = 1.0
	case "medium":
		v = 0.5
	case "high":
		v = 0.0
	}
	return Factor{Raw: level, Value: v}
}

func blastFactor(t store.Task, sk *skill.Loaded, full int64) Factor {
	// Reach into task.features for size estimates. The blast metric depends
	// on action; we keep this dispatch local rather than spreading custom
	// methods across skills.
	bytes := estimateBlastBytes(t, sk)
	if full <= 0 {
		full = 100 * 1024 * 1024 * 1024
	}
	frac := float64(bytes) / float64(full)
	if frac > 1 {
		frac = 1
	}
	if frac < 0 {
		frac = 0
	}
	return Factor{
		Raw:   bytes,
		Value: clamp01(1 - frac),
		Notes: fmt.Sprintf("estimated_bytes=%d full=%d", bytes, full),
	}
}

// estimateBlastBytes returns a best-effort affected-bytes estimate per skill.
// For replication repair we pull missing × replicas_expected × volume_size.
// For other shell-driven ops we use volume size or 0 (cluster-wide ops are
// inherently big; report 0 so the factor penalizes them).
func estimateBlastBytes(t store.Task, _ *skill.Loaded) int64 {
	var feat map[string]any
	if len(t.Features) > 0 {
		_ = json.Unmarshal(t.Features, &feat)
	}
	switch t.Action {
	case "fix_replication":
		size := readFloat(feat, "size_bytes")
		missing := readFloat(feat, "missing")
		if size == 0 {
			size = readFloat(feat, "volume_size")
		}
		if missing == 0 {
			missing = 1
		}
		return int64(size * missing)
	case "tier_upload", "tier_download", "tier_move":
		return int64(readFloat(feat, "size_bytes"))
	case "ec_encode", "ec_decode":
		return int64(readFloat(feat, "size_bytes"))
	case "balance":
		// Cluster-wide rebalance; can't bound easily.
		return 0
	case "vacuum", "fsck":
		// Read-only-ish cluster pass; treat as zero blast for autonomy.
		return 1 // tiny positive so factor is ~1.0
	case "shrink":
		return int64(readFloat(feat, "deleted_bytes"))
	}
	return 0
}

func readFloat(m map[string]any, k string) float64 {
	if m == nil {
		return 0
	}
	v, ok := m[k]
	if !ok {
		return 0
	}
	switch x := v.(type) {
	case float64:
		return x
	case float32:
		return float64(x)
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case uint64:
		return float64(x)
	}
	return 0
}

func pressureFactor(p *pressure.Score) Factor {
	if p == nil {
		// Nil Raw signals "no data" — Calculate() will skip this factor and
		// renormalize the remaining weights. Important: don't synthesize a
		// neutral 0.5 that would penalize tasks just because the pressure
		// sampler hasn't populated this cluster yet.
		return Factor{Raw: nil, Value: 0, Notes: "no pressure signal yet — factor skipped"}
	}
	return Factor{Raw: p.Value, Value: clamp01(1 - p.Value)}
}

func windowFactor(frozen, offPeak bool) Factor {
	switch {
	case frozen:
		return Factor{Raw: "frozen", Value: 0}
	case offPeak:
		return Factor{Raw: "off_peak", Value: 1.0}
	default:
		return Factor{Raw: "peak", Value: 0.5}
	}
}

func aiFactor(r *AIReviewSummary) Factor {
	if r == nil {
		// AI review hasn't run yet (worker tick race). Skip the factor —
		// Calculate() renormalizes — rather than pretending we got a neutral
		// signal, which previously dragged scores down by ~0.1.
		return Factor{Raw: nil, Value: 0, Notes: "no AI review yet — factor skipped (will rescore after aireview runs)"}
	}
	base := 0.0
	switch r.Verdict {
	case "proceed":
		base = 1.0
	case "needs_human":
		base = 0.5
	case "abort":
		base = 0.0
	default:
		base = 0.5
	}
	// Weight by confidence and consensus.
	consensus := 0.0
	if r.Rounds > 0 {
		consensus = float64(r.RoundsOK) / float64(r.Rounds)
	}
	v := base * (0.6 + 0.4*consensus) * (0.5 + 0.5*r.Confidence)
	return Factor{
		Raw:   fmt.Sprintf("%s×%d/%d c=%.2f", r.Verdict, r.RoundsOK, r.Rounds, r.Confidence),
		Value: clamp01(v),
	}
}

// ---------------- pure helpers ----------------

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

// PersistScore writes the score to tasks.autonomy_score JSONB.
func PersistScore(ctx context.Context, pg *store.PG, taskID uuid.UUID, s Score) error {
	b, err := json.Marshal(s)
	if err != nil {
		return fmt.Errorf("marshal autonomy score: %w", err)
	}
	_, err = pg.Pool.Exec(ctx, `UPDATE tasks SET autonomy_score=$1 WHERE id=$2`, b, taskID)
	if err != nil {
		return fmt.Errorf("save autonomy score: %w", err)
	}
	return nil
}
