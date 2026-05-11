package autonomy

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/pressure"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// AIClaim is one factor the LLM listed when it voted needs_human / abort.
// `Note` is the model's free-text justification; `Weight` is how much it
// thought this concern mattered.
type AIClaim struct {
	Name   string  `json:"name"`
	Weight float64 `json:"weight"`
	Note   string  `json:"note"`
}

// Rebuttal documents how ground truth contradicts (or supports) one claim.
type Rebuttal struct {
	Claim     AIClaim `json:"claim"`
	Category  string  `json:"category"`  // peak_hours | replication_storm | ...
	Rebutted  bool    `json:"rebutted"`  // ground truth says the AI was wrong
	Evidence  string  `json:"evidence"`  // human-readable proof
}

// VetoAssessment is what RebutAIClaims returns to Calculate. When
// EffectiveVetoWeight is below the configured threshold, the AI's
// needs_human is downgraded from "veto" to "advisory" — the operator still
// sees the AI's concerns on the page, but the autonomy gate proceeds.
type VetoAssessment struct {
	Rebuttals          []Rebuttal `json:"rebuttals"`
	TotalWeight        float64    `json:"total_weight"`
	RebuttedWeight     float64    `json:"rebutted_weight"`
	EffectiveStrength  float64    `json:"effective_strength"` // unrebutted / total ∈ [0,1]
	Override           bool       `json:"override"`           // true ⇒ ignore AI veto
}

// RebutAIClaims walks the AI's stated concerns and checks each against
// ground truth. Result feeds into Calculate(): a heavily-rebutted veto is
// downgraded so autonomy can still auto-approve.
//
// `factorsJSON` is the JSONB from ai_review_rounds.factors of the most
// critical round (typically the last needs_human / abort vote).
func RebutAIClaims(factorsJSON json.RawMessage, task store.Task, sk SkillInfo,
	press *pressure.Score, blastBytes int64, now time.Time,
	overrideStrengthThreshold float64,
) VetoAssessment {
	var claims []AIClaim
	_ = json.Unmarshal(factorsJSON, &claims)

	out := VetoAssessment{}
	for _, c := range claims {
		r := classifyAndCheck(c, task, sk, press, blastBytes, now)
		out.Rebuttals = append(out.Rebuttals, r)
		out.TotalWeight += c.Weight
		if r.Rebutted {
			out.RebuttedWeight += c.Weight
		}
	}
	if out.TotalWeight > 0 {
		out.EffectiveStrength = 1 - (out.RebuttedWeight / out.TotalWeight)
	}
	if overrideStrengthThreshold <= 0 {
		overrideStrengthThreshold = 0.5
	}
	// Override AI veto when more than half of the (weighted) reasons were
	// rebutted by ground truth.
	out.Override = out.TotalWeight > 0 && out.EffectiveStrength < overrideStrengthThreshold
	return out
}

// SkillInfo is the slice of skill metadata the rebutter needs without
// pulling the full skill.Loaded type (avoids an import cycle).
type SkillInfo struct {
	Key               string
	RiskLevel         string
	IsIdempotent      bool   // copy-only ops (fix_replication, balance) are idempotent
	HoldsClusterLock  bool   // skill acquires acquire_cluster_repair_lock or similar
}

// classifyAndCheck maps one AI claim into a category and checks the
// ground truth. Claim names from the LLM aren't a fixed enum — we match
// on keywords (Chinese + English) since prompts can drift.
func classifyAndCheck(c AIClaim, task store.Task, sk SkillInfo,
	press *pressure.Score, blastBytes int64, now time.Time,
) Rebuttal {
	r := Rebuttal{Claim: c}
	lower := strings.ToLower(c.Name + " " + c.Note)

	switch {
	// Peak hours / load — verify against actual pressure score + clock.
	case hasAny(lower, "peak", "高峰", "busy hour", "时段", "rush"):
		r.Category = "peak_hours"
		// Off-peak hour (23-06 local) → rebut.
		if isOffPeak(now) {
			r.Rebutted = true
			r.Evidence = fmt.Sprintf("当前 %s 处于低峰窗口 (23:00-06:00)", now.Format("15:04"))
			return r
		}
		// Low measured pressure → rebut.
		if press != nil && press.Value < 0.30 {
			r.Rebutted = true
			r.Evidence = fmt.Sprintf("集群实测 pressure=%.2f,远低于忙阈值 0.60,不构成高峰", press.Value)
			return r
		}
		r.Evidence = "pressure 高或时段确为高峰,声称成立"
		return r

	// Replication / load storm — fix_replication takes the cluster repair
	// lock; SeaweedFS shell also serializes via admin lock; bounded
	// concurrency via -maxParallelization. The "storm" risk is mitigated.
	case hasAny(lower, "replication storm", "复制风暴", "storm", "cascade"):
		r.Category = "replication_storm"
		if sk.HoldsClusterLock {
			r.Rebutted = true
			r.Evidence = "skill 持有 cluster_repair_lock + SeaweedFS admin lock + -maxParallelization 受限于压力,不可能并发风暴"
			return r
		}
		r.Evidence = "无 cluster lock 保护,声称成立"
		return r

	// Data inconsistency / overwrite — fix_replication is copy-only and
	// idempotent (no .dat deletion when -doDelete=false). Hard rebut for
	// idempotent skills.
	case hasAny(lower, "data inconsistency", "数据一致性", "overwrite", "覆盖", "loss"):
		r.Category = "data_integrity"
		if sk.IsIdempotent {
			r.Rebutted = true
			r.Evidence = fmt.Sprintf("%s 是幂等操作(仅复制副本,-doDelete=false),不会覆盖或丢数据", sk.Key)
			return r
		}
		r.Evidence = "skill 非幂等,声称成立"
		return r

	// Blast / size impact — check actual affected bytes.
	case hasAny(lower, "volume size", "blast", "影响", "performance", "性能", "io", "bandwidth", "带宽"):
		r.Category = "io_impact"
		// Empirical: ≤ 100 MiB is effectively instant on any disk.
		const trivial = int64(100 * 1024 * 1024)
		if blastBytes > 0 && blastBytes <= trivial {
			r.Rebutted = true
			r.Evidence = fmt.Sprintf("受影响数据仅 %s,远低于 100 MiB,IO 冲击可忽略", humanBytes(blastBytes))
			return r
		}
		if blastBytes == 0 {
			r.Evidence = "影响大小未知,声称需保留"
			return r
		}
		r.Evidence = fmt.Sprintf("受影响数据 %s,声称成立", humanBytes(blastBytes))
		return r

	// Rollback difficulty — fix_replication's failure mode is "abort the
	// shell, the master will re-detect under-replication next pass". No
	// state corruption. Rebut for cluster-lock-protected, idempotent ops.
	case hasAny(lower, "rollback", "回滚", "irreversible"):
		r.Category = "rollback"
		if sk.IsIdempotent && sk.HoldsClusterLock {
			r.Rebutted = true
			r.Evidence = "幂等 + 集群锁保护:中断后下一轮调度会自动重试,无需显式回滚"
			return r
		}
		r.Evidence = "skill 非幂等或无 cluster lock,回滚顾虑成立"
		return r

	// Cyclical / pattern / 周期性 — without a real periodicity signal
	// from our pattern analyzer, we can't rebut. Pass through.
	case hasAny(lower, "cyclical", "周期", "pattern", "acf"):
		r.Category = "cyclical"
		r.Evidence = "周期性模式声称无法用当前指标核验,保留"
		return r

	default:
		r.Category = "uncategorized"
		r.Evidence = "未识别的声称,保留"
		return r
	}
}

func hasAny(s string, needles ...string) bool {
	for _, n := range needles {
		if strings.Contains(s, strings.ToLower(n)) {
			return true
		}
	}
	return false
}

func humanBytes(b int64) string {
	switch {
	case b >= 1<<30:
		return fmt.Sprintf("%.1f GiB", float64(b)/float64(1<<30))
	case b >= 1<<20:
		return fmt.Sprintf("%.1f MiB", float64(b)/float64(1<<20))
	case b >= 1<<10:
		return fmt.Sprintf("%.1f KiB", float64(b)/float64(1<<10))
	default:
		return fmt.Sprintf("%d B", b)
	}
}
