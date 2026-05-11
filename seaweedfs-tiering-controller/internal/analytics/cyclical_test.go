package analytics

import (
	"math"
	"testing"
)

func TestDetect_FlatSeries(t *testing.T) {
	xs := make([]uint32, 168)
	for i := range xs {
		xs[i] = 100
	}
	p := Detect(1, xs)
	if p.Kind != CycleFlat {
		t.Fatalf("flat series → got %s", p.Kind)
	}
}

func TestDetect_DailyCycle(t *testing.T) {
	// 7 days, hourly: hot 9-17, cold 0-8 + 18-23.
	xs := make([]uint32, 168)
	for h := 0; h < 168; h++ {
		hour := h % 24
		if hour >= 9 && hour < 17 {
			xs[h] = 1000
		} else {
			xs[h] = 10
		}
	}
	p := Detect(1, xs)
	if p.Kind != CycleDaily {
		t.Fatalf("daily series → got %s (acf24=%.2f acf168=%.2f)",
			p.Kind, p.ACF24h, p.ACF168h)
	}
	if math.Abs(float64(p.ACF24h)) < 0.5 {
		t.Fatalf("acf24h too low: %.2f", p.ACF24h)
	}
}

func TestDetect_TooShort(t *testing.T) {
	xs := make([]uint32, 24) // less than minSamplesForACF
	for i := range xs {
		xs[i] = uint32(i)
	}
	p := Detect(1, xs)
	if p.Kind != CycleUnknown {
		t.Fatalf("short series → got %s", p.Kind)
	}
}

func TestDetect_Spiky(t *testing.T) {
	xs := make([]uint32, 168)
	for i := range xs {
		xs[i] = 5
	}
	xs[80] = 50000 // single rare burst dominates
	p := Detect(1, xs)
	if p.Kind != CycleSpiky {
		t.Fatalf("spiky series → got %s (acf24=%.2f)", p.Kind, p.ACF24h)
	}
}

func TestScoreCohorts_ZScoreFlagsAnomaly(t *testing.T) {
	// 30 volumes clustered ~100 reads + 1 outlier far away. Larger cohort
	// keeps the outlier from dominating its own mean/stddev (which is the
	// real-world scenario — z-score is meaningful only with enough peers).
	rows := []CohortRow{}
	for i := 1; i <= 30; i++ {
		rows = append(rows, CohortRow{
			VolumeID: uint32(i), BusinessDomain: "hotel", SizeBytes: 100,
			Pattern: Pattern{Reads7d: uint64(95 + (i % 11))}, // 95..105
		})
	}
	rows = append(rows, CohortRow{
		VolumeID: 999, BusinessDomain: "hotel", SizeBytes: 100,
		Pattern: Pattern{Reads7d: 5000}, // ~150σ above peers
	})
	scored, baselines := ScoreCohorts(rows)
	if len(baselines) != 1 {
		t.Fatalf("expected 1 baseline, got %d", len(baselines))
	}
	var outlier ScoredRow
	for _, s := range scored {
		if s.VolumeID == 999 {
			outlier = s
		}
	}
	if !IsAnomalous(outlier) {
		t.Fatalf("outlier not flagged: z=%.2f", outlier.CohortZReads)
	}
}

func TestPercentiles(t *testing.T) {
	xs := []uint64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
	p50, p95 := percentilesUint64(xs, 0.5, 0.95)
	if p50 != 5 || p95 != 10 {
		t.Fatalf("p50=%d p95=%d", p50, p95)
	}
}
