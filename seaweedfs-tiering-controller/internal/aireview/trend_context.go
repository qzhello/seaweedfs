package aireview

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// buildTrendContext summarises a volume's recent feature history into one
// line for prompt injection. It compares the head and tail of the 30-day
// window so the model can tell a genuinely-cooling volume from a temporary
// lull, and reports peak reads + volatility so "always quiet" reads
// differently from "was busy, now quiet".
//
// Returns "" on any error or when there's too little history — callers
// inject the value verbatim and degrade gracefully on an empty string,
// exactly like CohortContext / PatternContext.
func buildTrendContext(ctx context.Context, ch *store.CH, volumeID uint32) string {
	if ch == nil {
		return ""
	}
	since := time.Now().Add(-30 * 24 * time.Hour)
	samples, err := ch.VolumeFeatureTrend(ctx, volumeID, since, 0)
	if err != nil || len(samples) < 2 {
		return ""
	}
	first, last := samples[0], samples[len(samples)-1]

	// Single pass: peak 7-day reads and the moments needed for volatility.
	var peak uint64
	var sum, sumSq float64
	for _, s := range samples {
		if s.Reads7d > peak {
			peak = s.Reads7d
		}
		r := float64(s.Reads7d)
		sum += r
		sumSq += r * r
	}
	n := float64(len(samples))
	mean := sum / n
	volatility := "low"
	if mean > 0 {
		variance := sumSq/n - mean*mean
		cv := 0.0
		if variance > 0 {
			cv = math.Sqrt(variance) / mean
		}
		switch {
		case cv > 0.7:
			volatility = "high"
		case cv > 0.3:
			volatility = "medium"
		}
	}

	return fmt.Sprintf(
		"window=30d samples=%d size_trend=%s reads7d_trend=%s reads7d_now=%d reads7d_peak=%d volatility=%s quiet_days_now=%d",
		len(samples),
		pctDelta(float64(first.SizeBytes), float64(last.SizeBytes)),
		pctDelta(float64(first.Reads7d), float64(last.Reads7d)),
		last.Reads7d, peak, volatility, last.QuietDays)
}

// pctDelta renders a from→to change as a compact signed percentage,
// collapsing swings under 5% to "flat" so the model isn't distracted by
// noise. A zero baseline becomes "new" (growth from nothing) or "flat".
func pctDelta(from, to float64) string {
	if from <= 0 {
		if to <= 0 {
			return "flat"
		}
		return "new"
	}
	pct := (to - from) / from * 100
	switch {
	case pct >= 5:
		return fmt.Sprintf("+%.0f%%", pct)
	case pct <= -5:
		return fmt.Sprintf("%.0f%%", pct)
	default:
		return "flat"
	}
}
