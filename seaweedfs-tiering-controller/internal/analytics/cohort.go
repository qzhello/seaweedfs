package analytics

import (
	"math"
	"sort"
)

// CohortRow is the per-volume payload that pairs a Pattern with the metadata
// needed for cohort grouping. Provided by the caller (controller pulls
// business_domain from PG resource_tags).
type CohortRow struct {
	VolumeID       uint32
	BusinessDomain string
	SizeBytes      uint64
	Pattern        Pattern
}

// CohortBaseline is per-domain summary used for the dashboard "this domain
// normally does X reads/byte" panels.
type CohortBaseline struct {
	BusinessDomain     string
	VolumeCount        uint32
	MeanReadsPerByte   float64
	StddevReadsPerByte float64
	P50Reads           uint64
	P95Reads           uint64
}

// ScoredRow is the output: the input row plus its z-score within its cohort.
type ScoredRow struct {
	CohortRow
	ReadsPerByte7d float64 // 0 if size_bytes == 0
	CohortZReads   float32
}

// ScoreCohorts groups by business_domain, computes mean/stddev of reads/byte,
// and returns a Z-score per row plus a baseline per cohort. Volumes with
// SizeBytes==0 (placeholders) are kept but get reads_per_byte=0 and Z=0.
func ScoreCohorts(rows []CohortRow) ([]ScoredRow, []CohortBaseline) {
	// Bucket per domain.
	type bucket struct {
		rows   []*ScoredRow
		ratios []float64
		reads  []uint64
	}
	by := map[string]*bucket{}
	scored := make([]ScoredRow, len(rows))

	for i, r := range rows {
		s := &scored[i]
		s.CohortRow = r
		if r.SizeBytes > 0 {
			s.ReadsPerByte7d = float64(r.Pattern.Reads7d) / float64(r.SizeBytes)
		}
		domain := r.BusinessDomain
		if domain == "" {
			domain = "other"
			s.BusinessDomain = domain
		}
		b, ok := by[domain]
		if !ok {
			b = &bucket{}
			by[domain] = b
		}
		b.rows = append(b.rows, s)
		if s.ReadsPerByte7d > 0 {
			b.ratios = append(b.ratios, s.ReadsPerByte7d)
		}
		b.reads = append(b.reads, r.Pattern.Reads7d)
	}

	baselines := make([]CohortBaseline, 0, len(by))
	for domain, b := range by {
		mean, stddev := meanStddevFloat(b.ratios)
		p50, p95 := percentilesUint64(b.reads, 0.50, 0.95)
		baselines = append(baselines, CohortBaseline{
			BusinessDomain:     domain,
			VolumeCount:        uint32(len(b.rows)),
			MeanReadsPerByte:   mean,
			StddevReadsPerByte: stddev,
			P50Reads:           p50,
			P95Reads:           p95,
		})
		// Z-score every row in the bucket.
		for _, r := range b.rows {
			if stddev == 0 || r.ReadsPerByte7d == 0 {
				continue
			}
			r.CohortZReads = float32((r.ReadsPerByte7d - mean) / stddev)
		}
	}
	// Stable order for deterministic tests + reproducible UI.
	sort.Slice(scored, func(i, j int) bool { return scored[i].VolumeID < scored[j].VolumeID })
	sort.Slice(baselines, func(i, j int) bool { return baselines[i].BusinessDomain < baselines[j].BusinessDomain })
	return scored, baselines
}

func meanStddevFloat(xs []float64) (mean, stddev float64) {
	if len(xs) == 0 {
		return 0, 0
	}
	var sum float64
	for _, x := range xs {
		sum += x
	}
	mean = sum / float64(len(xs))
	var sq float64
	for _, x := range xs {
		d := x - mean
		sq += d * d
	}
	stddev = math.Sqrt(sq / float64(len(xs)))
	return mean, stddev
}

// percentilesUint64 returns the requested quantiles using nearest-rank — good
// enough for cohort summaries where exact interpolation isn't worth a sort
// cost in the hot path.
func percentilesUint64(xs []uint64, qs ...float64) (uint64, uint64) {
	if len(xs) == 0 {
		return 0, 0
	}
	sorted := append([]uint64(nil), xs...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	pick := func(q float64) uint64 {
		if q <= 0 {
			return sorted[0]
		}
		if q >= 1 {
			return sorted[len(sorted)-1]
		}
		idx := int(math.Ceil(q*float64(len(sorted)))) - 1
		if idx < 0 {
			idx = 0
		}
		return sorted[idx]
	}
	return pick(qs[0]), pick(qs[1])
}

// AnomalyThreshold is the cohort z-score above which we flag a volume for
// the anomaly Skill. Surfaced as a constant so the UI legend can read it.
const AnomalyThreshold = 3.0

// IsAnomalous reports whether a row's cohort z-score is large enough to flag.
// Negative direction (reads << peers) is also flagged — that often indicates
// a forgotten data source.
func IsAnomalous(s ScoredRow) bool {
	z := math.Abs(float64(s.CohortZReads))
	return z >= AnomalyThreshold
}
