// Package pressure computes a per-cluster 0..1 pressure score from the
// monitor_targets table maintained by the health scraper, persists snapshots
// to cluster_pressure_signals, and exposes the latest score for the
// scheduler + watchdog to consult.
//
// Why a separate score (not just the health gate): the gate is binary
// (ok/closed) and triggered on single-target failures. Pressure is a
// continuous knob — a 75% CPU cluster is still "healthy" but we shouldn't
// pile more replication work on it.
package pressure

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"go.uber.org/zap"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/metrics"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/runtime"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// Snapshot is the cached, hot-read view of pressure scores per cluster.
// Sampler refreshes it; Threshold() + Get() are lock-free readers.
type Snapshot struct {
	mu    sync.RWMutex
	by    map[uuid.UUID]Score
	thr   float64
}

// Score is one cluster's current pressure + the components that contributed.
type Score struct {
	Cluster    uuid.UUID
	Value      float64            // 0..1
	Components map[string]float64 // per-metric raw value
	SampledAt  time.Time
}

func NewSnapshot() *Snapshot {
	return &Snapshot{by: map[uuid.UUID]Score{}, thr: 0.6}
}

// Get returns the latest score for a cluster. Zero score + ok=false means
// "no signal yet" — scheduler should default to "allow" rather than block.
func (s *Snapshot) Get(cluster uuid.UUID) (Score, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sc, ok := s.by[cluster]
	return sc, ok
}

// Threshold returns the global "busy" cutoff. The watchdog adds hysteresis
// when interrupting in-flight work.
func (s *Snapshot) Threshold() float64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.thr
}

// IsBusy returns true if the cluster's latest score is above threshold.
// Missing-signal clusters return false (fail-open) — better to admit work
// than starve forever waiting for a metric pipeline to come online.
func (s *Snapshot) IsBusy(cluster uuid.UUID) bool {
	sc, ok := s.Get(cluster)
	if !ok {
		return false
	}
	return sc.Value >= s.Threshold()
}

// All returns a copy of every cluster's last score. Used by the UI.
func (s *Snapshot) All() []Score {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Score, 0, len(s.by))
	for _, v := range s.by {
		out = append(out, v)
	}
	return out
}

func (s *Snapshot) replace(scores map[uuid.UUID]Score, thr float64) {
	s.mu.Lock()
	s.by = scores
	s.thr = thr
	s.mu.Unlock()
}

// ---------------- Prometheus metric ----------------

// pressureGauge exposes tier_cluster_pressure{cluster=<id>} so Grafana /
// alertmanager can chart and alert on it.
var pressureGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
	Name: "tier_cluster_pressure",
	Help: "Normalized 0..1 cluster pressure score used by the scheduler/watchdog.",
}, []string{"cluster", "cluster_name"})

func init() {
	metrics.Registry.MustRegister(pressureGauge)
}

// ---------------- Sampler ----------------

// Sampler periodically computes pressure for every enabled cluster and
// persists a snapshot to PG + updates the in-memory Snapshot.
type Sampler struct {
	pg       *store.PG
	snap     *Snapshot
	runtime  *runtime.Snapshot
	log      *zap.Logger
}

func NewSampler(pg *store.PG, snap *Snapshot, rt *runtime.Snapshot, log *zap.Logger) *Sampler {
	return &Sampler{pg: pg, snap: snap, runtime: rt, log: log}
}

// Run blocks until ctx cancels, sampling on the configured interval.
func (s *Sampler) Run(ctx context.Context) {
	tick := time.NewTicker(s.interval())
	defer tick.Stop()
	// Prime once immediately so the scheduler has data on first tick.
	_ = s.sampleOnce(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			_ = s.sampleOnce(ctx)
			// Rebuild ticker if interval was hot-edited.
			if d := s.interval(); d != 0 {
				tick.Reset(d)
			}
		}
	}
}

func (s *Sampler) interval() time.Duration {
	secs := 30
	if s.runtime != nil {
		secs = s.runtime.Int("pressure.sample_interval_seconds", 30)
	}
	if secs < 10 {
		secs = 10
	}
	return time.Duration(secs) * time.Second
}

// sampleOnce computes one snapshot for every cluster and persists it.
func (s *Sampler) sampleOnce(ctx context.Context) error {
	weights := s.weights()
	threshold := s.threshold()

	clusters, err := s.pg.ListClusters(ctx)
	if err != nil {
		return err
	}
	targets, err := s.pg.ListMonitorTargets(ctx)
	if err != nil {
		return err
	}
	healthRows, err := s.pg.ListHealthState(ctx)
	if err != nil {
		return err
	}
	// Index health by target_id for O(1) lookup.
	healthBy := map[uuid.UUID]store.HealthRow{}
	for _, h := range healthRows {
		healthBy[h.TargetID] = h
	}

	scores := map[uuid.UUID]Score{}
	for _, c := range clusters {
		if !c.Enabled {
			continue
		}
		sc := computeOne(c.ID, c.Name, targets, healthBy, weights)
		scores[c.ID] = sc
		pressureGauge.WithLabelValues(c.ID.String(), c.Name).Set(sc.Value)
		if err := WriteSnapshot(ctx, s.pg, c.ID, sc.Value, sc.Components); err != nil {
			s.log.Warn("persist pressure snapshot", zap.String("cluster", c.Name), zap.Error(err))
		}
	}
	s.snap.replace(scores, threshold)
	return nil
}

func (s *Sampler) weights() map[string]float64 {
	out := map[string]float64{"cpu_p95": 0.4, "disk_util_p95": 0.4, "io_wait": 0.2}
	if s.runtime == nil {
		return out
	}
	raw := s.runtime.JSON("pressure.weights")
	if len(raw) == 0 {
		return out
	}
	var parsed map[string]float64
	if err := json.Unmarshal(raw, &parsed); err == nil && len(parsed) > 0 {
		return parsed
	}
	return out
}

func (s *Sampler) threshold() float64 {
	if s.runtime == nil {
		return 0.6
	}
	v := s.runtime.Float("pressure.threshold", 0.6)
	if v <= 0 || v > 1 {
		return 0.6
	}
	return v
}

// computeOne builds one cluster's pressure score.
//
// Matching rule: weight key matches either:
//   - exact monitor_target.name, or
//   - case-insensitive substring of name (so `cpu_p95` weight catches
//     `qa-cpu-p95-cluster1` etc.)
//
// Each matched target's last_value is clamped to 0..1 (with sensible per-key
// normalization) and contributes weight × value. Total weights are
// renormalized to 1.0 across matched keys so missing metrics don't depress
// the score artificially.
func computeOne(clusterID uuid.UUID, clusterName string,
	targets []store.MonitorTarget,
	health map[uuid.UUID]store.HealthRow,
	weights map[string]float64,
) Score {
	components := map[string]float64{}
	matchedWeightSum := 0.0
	weighted := 0.0

	for key, w := range weights {
		if w <= 0 {
			continue
		}
		// Find a target for this cluster whose name matches the key.
		for _, t := range targets {
			if !t.Enabled || t.ClusterID == nil || *t.ClusterID != clusterID {
				continue
			}
			if !nameMatches(t.Name, key) {
				continue
			}
			h, ok := health[t.ID]
			if !ok || h.LastValue == nil {
				continue
			}
			v := normalize(key, *h.LastValue)
			components[key] = v
			weighted += w * v
			matchedWeightSum += w
			break
		}
	}
	score := 0.0
	if matchedWeightSum > 0 {
		score = weighted / matchedWeightSum
	}
	if score < 0 {
		score = 0
	} else if score > 1 {
		score = 1
	}
	return Score{
		Cluster:    clusterID,
		Value:      score,
		Components: components,
		SampledAt:  time.Now(),
	}
}

func nameMatches(targetName, key string) bool {
	tn := strings.ToLower(targetName)
	k := strings.ToLower(key)
	return tn == k || strings.Contains(tn, k)
}

// normalize maps a raw metric value to 0..1. Each metric family has its own
// expected range — CPU 0..100 → /100, io_wait already 0..1 etc.
func normalize(key string, raw float64) float64 {
	if math.IsNaN(raw) {
		return 0
	}
	k := strings.ToLower(key)
	switch {
	case strings.Contains(k, "cpu"), strings.Contains(k, "disk_util"):
		// Most exporters report 0..100 (percent). If already 0..1 the /100
		// rounds tiny values to 0 — clamp at end fixes that.
		if raw > 1.5 {
			return clamp01(raw / 100)
		}
		return clamp01(raw)
	case strings.Contains(k, "io_wait"), strings.Contains(k, "iowait"):
		return clamp01(raw)
	default:
		return clamp01(raw)
	}
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

// ---------------- store helpers ----------------

// Component encoded so PG INSERT can take JSONB.
func encodeComponents(c map[string]float64) ([]byte, error) {
	if len(c) == 0 {
		return []byte("{}"), nil
	}
	return json.Marshal(c)
}

// Public helper since the store package would otherwise need to know our
// internal types.
func WriteSnapshot(ctx context.Context, pg *store.PG, clusterID uuid.UUID, score float64, components map[string]float64) error {
	b, err := encodeComponents(components)
	if err != nil {
		return fmt.Errorf("encode pressure components: %w", err)
	}
	return pg.InsertPressureSnapshotRaw(ctx, clusterID, score, b)
}
