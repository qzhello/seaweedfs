// Package analytics computes higher-order signals on top of the raw access
// log: cyclical patterns (daily/weekly), cohort baselines per business
// domain, and the z-scores used to flag anomalies.
//
// All math runs in Go because (a) we need exact control of windowing and
// (b) ClickHouse's window functions for time-series autocorrelation are
// awkward and harder to test.
package analytics

import (
	"context"
	"fmt"
	"math"
	"time"
)

// SeriesSource is what the cyclical detector needs from CH. Defined as an
// interface so tests can plug a fake without spinning up ClickHouse.
type SeriesSource interface {
	HourlyReads(ctx context.Context, volumeID uint32, since time.Time, hours int) ([]uint32, error)
}

// CycleKind classifies a volume's access shape. Used by the scorer to bias
// migrations: a 'daily' volume with deep nightly troughs is a great cold-tier
// candidate during off-hours but a bad one during the day.
type CycleKind string

const (
	CycleUnknown CycleKind = "unknown"
	CycleFlat    CycleKind = "flat"
	CycleDaily   CycleKind = "daily"
	CycleWeekly  CycleKind = "weekly"
	CycleSpiky   CycleKind = "spiky"
)

// Pattern is the per-volume fingerprint persisted to CH and shown in the
// volume profile page.
type Pattern struct {
	VolumeID      uint32
	ACF24h        float32
	ACF168h       float32
	Kind          CycleKind
	Reads7d       uint64
	Sparkline168h []uint32 // oldest → newest, hourly bucket
}

// Thresholds — tuned from observation, exposed as constants so the
// /skills/cohort UI can show "we mark cyclical when acf >= 0.5" without
// inventing numbers.
const (
	cyclicalThreshold = 0.5  // autocorrelation magnitude
	flatStdDevRatio   = 0.15 // stddev/mean below this ⇒ flat
	spikyZThreshold   = 4.0  // any single-hour z > this ⇒ spiky
	minSamplesForACF  = 48   // need at least 2 days of data
)

// Detect classifies one volume's access shape from its hourly read series.
// The series must be in chronological order, oldest first. Returns CycleUnknown
// if there isn't enough data to be confident.
func Detect(volumeID uint32, hourly []uint32) Pattern {
	p := Pattern{
		VolumeID:      volumeID,
		Kind:          CycleUnknown,
		Sparkline168h: hourly,
	}
	for _, v := range hourly {
		p.Reads7d += uint64(v)
	}
	if len(hourly) < minSamplesForACF {
		return p
	}

	mean, stddev := meanStddev(hourly)
	if stddev == 0 {
		// Truly silent — neither flat nor cyclical, just dead.
		p.Kind = CycleFlat
		return p
	}

	p.ACF24h = float32(autocorr(hourly, 24, mean))
	if len(hourly) >= 168 {
		p.ACF168h = float32(autocorr(hourly, 168, mean))
	}

	// Flat takes priority: low variance regardless of weak periodicity.
	if mean > 0 && stddev/mean < flatStdDevRatio {
		p.Kind = CycleFlat
		return p
	}

	// Spiky: one rare burst dominates the signal — bad cold-tier candidate
	// because the spike re-warms it.
	maxZ := 0.0
	for _, v := range hourly {
		z := math.Abs((float64(v) - mean) / stddev)
		if z > maxZ {
			maxZ = z
		}
	}
	// Only call it spiky if there's no strong cycle to explain the spike.
	if maxZ > spikyZThreshold &&
		math.Abs(float64(p.ACF24h)) < cyclicalThreshold &&
		math.Abs(float64(p.ACF168h)) < cyclicalThreshold {
		p.Kind = CycleSpiky
		return p
	}

	// Weekly cycles often also show daily structure — pick the stronger.
	if math.Abs(float64(p.ACF168h)) >= cyclicalThreshold &&
		math.Abs(float64(p.ACF168h)) > math.Abs(float64(p.ACF24h)) {
		p.Kind = CycleWeekly
		return p
	}
	if math.Abs(float64(p.ACF24h)) >= cyclicalThreshold {
		p.Kind = CycleDaily
		return p
	}
	return p
}

// meanStddev computes the population mean and standard deviation in one pass.
// Safe on empty input (returns zeros).
func meanStddev(xs []uint32) (mean, stddev float64) {
	if len(xs) == 0 {
		return 0, 0
	}
	var sum float64
	for _, x := range xs {
		sum += float64(x)
	}
	mean = sum / float64(len(xs))
	var sq float64
	for _, x := range xs {
		d := float64(x) - mean
		sq += d * d
	}
	stddev = math.Sqrt(sq / float64(len(xs)))
	return mean, stddev
}

// autocorr returns Pearson autocorrelation at the given lag, mean-centered.
// Range [-1, 1]. Returns 0 if lag is out of range.
func autocorr(xs []uint32, lag int, mean float64) float64 {
	n := len(xs)
	if lag <= 0 || lag >= n {
		return 0
	}
	var num, den float64
	for i := 0; i < n; i++ {
		d := float64(xs[i]) - mean
		den += d * d
	}
	if den == 0 {
		return 0
	}
	for i := 0; i < n-lag; i++ {
		num += (float64(xs[i]) - mean) * (float64(xs[i+lag]) - mean)
	}
	return num / den
}

// Now is the package-level time source so tests can pin it.
var Now = time.Now

// SnapshotInputs bundles the upstream-facing dependencies of one run.
type SnapshotInputs struct {
	Source     SeriesSource
	VolumeIDs  []uint32
	WindowDays int // typically 7
}

// SnapshotResult is what BuildSnapshot returns: per-volume patterns ready to
// hand off to the cohort step.
type SnapshotResult struct {
	Patterns []Pattern
	At       time.Time
}

// BuildSnapshot runs the cyclical detector for every requested volume.
// Errors fetching one volume's series are logged into the result via a
// CycleUnknown placeholder rather than aborting the whole run.
func BuildSnapshot(ctx context.Context, in SnapshotInputs) (*SnapshotResult, error) {
	if in.Source == nil {
		return nil, fmt.Errorf("nil series source")
	}
	if in.WindowDays <= 0 {
		in.WindowDays = 7
	}
	hours := in.WindowDays * 24
	since := Now().Add(-time.Duration(hours) * time.Hour)
	out := &SnapshotResult{At: Now(), Patterns: make([]Pattern, 0, len(in.VolumeIDs))}
	for _, vid := range in.VolumeIDs {
		if err := ctx.Err(); err != nil {
			return out, err
		}
		series, err := in.Source.HourlyReads(ctx, vid, since, hours)
		if err != nil {
			out.Patterns = append(out.Patterns, Pattern{VolumeID: vid, Kind: CycleUnknown})
			continue
		}
		out.Patterns = append(out.Patterns, Detect(vid, series))
	}
	return out, nil
}
