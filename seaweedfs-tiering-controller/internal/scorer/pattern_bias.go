package scorer

import (
	"math"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// ApplyPatternBias adjusts a scoring Recommendation using the volume's
// cyclical pattern + cohort z-score. Mutates rec in place.
//
// Behavior:
//   - daily/weekly cyclical → dampen coldness by 20% (we expect it to heat up again).
//   - cohort_z >= +3 (much hotter than peers) → veto migration (set action=noop).
//   - cohort_z <= -3 (much colder than peers) → boost score by 0.10 (still capped).
//   - spiky → modest dampener (15%); rare bursts re-warm cold tiers.
//
// Numbers are conservative on purpose; Sprint 3-4 ships first cut, operators
// can re-tune via system_config later.
func ApplyPatternBias(rec *Recommendation, p *store.PatternRow) {
	if rec == nil || p == nil {
		return
	}
	bias := patternBias(p)
	rec.Score = clamp01(rec.Score + bias.scoreDelta)
	if bias.veto {
		rec.Action = "noop"
		rec.Target = map[string]string{}
	}
	if rec.Features == nil {
		rec.Features = map[string]float64{}
	}
	rec.Features["pattern_bias_score_delta"] = bias.scoreDelta
	rec.Features["pattern_acf_24h"] = float64(p.ACF24h)
	rec.Features["pattern_acf_168h"] = float64(p.ACF168h)
	rec.Features["pattern_cohort_z"] = float64(p.CohortZReads)
	if bias.veto {
		rec.Features["pattern_veto"] = 1
	}
}

type biasResult struct {
	scoreDelta float64
	veto       bool
}

func patternBias(p *store.PatternRow) biasResult {
	r := biasResult{}
	switch p.CycleKind {
	case "daily", "weekly":
		r.scoreDelta -= 0.20
	case "spiky":
		r.scoreDelta -= 0.15
	}
	z := math.Abs(float64(p.CohortZReads))
	if z >= 3 {
		if p.CohortZReads > 0 {
			// Hotter than peers — refuse to migrate cold even if rules say so.
			r.veto = true
		} else {
			// Colder than peers — likely forgotten data; nudge migration.
			r.scoreDelta += 0.10
		}
	}
	return r
}
