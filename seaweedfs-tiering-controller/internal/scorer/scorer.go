// Package scorer turns a (volume metadata, access stats) tuple into a
// "coldness" score in [0,1] plus a recommended action. Pure rules first,
// AI is a tie-breaker / explanation generator.
package scorer

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/ai"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/config"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/seaweed"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

type Recommendation struct {
	VolumeID    uint32                 `json:"volume_id"`
	Collection  string                 `json:"collection"`
	Server      string                 `json:"server"`
	DiskType    string                 `json:"disk_type"`
	Score       float64                `json:"score"`
	Action      string                 `json:"action"`
	Target      map[string]string      `json:"target"`
	Features    map[string]float64     `json:"features"`
	Explanation string                 `json:"explanation"`
}

type Scorer struct {
	cfg *config.Scoring
	ai  ai.Provider
}

func New(cfg *config.Scoring, provider ai.Provider) *Scorer {
	return &Scorer{cfg: cfg, ai: provider}
}

// Score one volume. Caller supplies metadata + access features.
// All weights are normalized; missing weights default to 0.
// businessDomain (may be "") selects per-domain weight/threshold overrides.
func (s *Scorer) Score(ctx context.Context, v seaweed.VolumeInfo, f *store.VolumeFeatures, businessDomain string) Recommendation {
	feats := buildFeatures(v, f)
	weights, thresholds := ApplyDomainOverride(s.cfg.Weights, s.cfg.Thresholds, businessDomain)
	score := weightedWith(weights, feats)

	action, target := decideWith(thresholds, score, v)

	rec := Recommendation{
		VolumeID:   v.ID,
		Collection: v.Collection,
		Server:     v.Server,
		DiskType:   v.DiskType,
		Score:      score,
		Action:     action,
		Target:     target,
		Features:   feats,
	}
	rec.Explanation = s.explain(ctx, rec, v)
	return rec
}

// buildFeatures normalizes each input into [0,1] where higher = colder.
func buildFeatures(v seaweed.VolumeInfo, f *store.VolumeFeatures) map[string]float64 {
	now := time.Now().Unix()
	quietSec := float64(0)
	if v.ModifiedAtSec > 0 {
		quietSec = float64(now - v.ModifiedAtSec)
	}
	lastAccessSec := quietSec // fallback to modify-time if no access feature
	var reads30d, sizeBytes float64
	if f != nil {
		if f.LastAccessSecs > 0 {
			lastAccessSec = float64(f.LastAccessSecs)
		}
		reads30d = float64(f.Reads30d)
		sizeBytes = float64(f.SizeBytes)
	} else {
		sizeBytes = float64(v.Size)
	}

	// Decaying access pressure: 0 = hot, 1 = ice cold.
	// Half-life of 30 days.
	accessDecay := 1.0 - math.Exp(-lastAccessSec/(30*86400))

	// More reads → less cold. log scale.
	accessPenalty := 1.0 / (1.0 + math.Log1p(reads30d))

	// Larger volumes more worth migrating; cap at 30GiB → 1.0.
	sizeBoost := math.Min(1.0, sizeBytes/(30*1024*1024*1024))

	readonly := 0.0
	if v.ReadOnly {
		readonly = 1.0
	}

	quietDays := math.Min(1.0, quietSec/(60*86400)) // 60d → saturated

	return map[string]float64{
		"last_access_decay": accessDecay,
		"access_count_30d":  accessPenalty,
		"object_size":       sizeBoost,
		"is_readonly":       readonly,
		"quiet_for_days":    quietDays,
	}
}

func weightedWith(weights, f map[string]float64) float64 {
	var sum, wsum float64
	for k, w := range weights {
		v, ok := f[k]
		if !ok {
			continue
		}
		sum += v * w
		wsum += w
	}
	if wsum == 0 {
		return 0
	}
	return clamp01(sum / wsum)
}

func decideWith(t map[string]float64, score float64, v seaweed.VolumeInfo) (string, map[string]string) {
	switch {
	case score >= t["to_archive"] && v.ReadOnly:
		return "tier_upload", map[string]string{"backend": "s3-archive"}
	case score >= t["to_cloud"] && v.ReadOnly:
		return "tier_upload", map[string]string{"backend": "s3-cold"}
	case score >= t["to_ec"]:
		return "ec_encode", map[string]string{}
	default:
		return "noop", map[string]string{}
	}
}

func (s *Scorer) explain(ctx context.Context, rec Recommendation, v seaweed.VolumeInfo) string {
	if s.ai == nil {
		return ruleExplanation(rec)
	}
	exp, err := s.ai.Explain(ctx, ai.ExplainInput{
		VolumeID: rec.VolumeID, Score: rec.Score, Action: rec.Action,
		Features: rec.Features, Collection: v.Collection, ReadOnly: v.ReadOnly,
	})
	if err != nil || exp == "" {
		return ruleExplanation(rec)
	}
	return exp
}

func ruleExplanation(r Recommendation) string {
	return fmt.Sprintf("score=%.3f via rules: decay=%.2f reads=%.2f size=%.2f ro=%.0f quiet=%.2f → %s",
		r.Score,
		r.Features["last_access_decay"], r.Features["access_count_30d"],
		r.Features["object_size"], r.Features["is_readonly"],
		r.Features["quiet_for_days"], r.Action)
}

func clamp01(x float64) float64 {
	switch {
	case x < 0:
		return 0
	case x > 1:
		return 1
	default:
		return x
	}
}
