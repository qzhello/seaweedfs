// Package durability periodically computes a per-cluster 0..100 durability
// score from replication health signals and persists snapshots to
// cluster_score_signals.  The score is surfaced by
// GET /api/v1/clusters/score/history as a sparkline time series.
//
// The actual score computation is injected via ScoreFunc so that this package
// does NOT import internal/api (which would create an import cycle — api
// already imports internal/store, internal/runtime, etc.).
// cmd/controller/main.go wires the two together with a thin closure.
package durability

import (
	"context"
	"encoding/json"
	"time"

	"go.uber.org/zap"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/runtime"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// ScoreFunc computes a durability score for one cluster.
// It returns the 0..100 score and a component map that is stored as JSONB
// for transparency + UI tooltip.
type ScoreFunc func(ctx context.Context, cl *store.Cluster) (score float64, components map[string]float64, err error)

// Sampler periodically computes the durability score for every enabled cluster
// and persists a snapshot to PG.
type Sampler struct {
	pg      *store.PG
	rt      *runtime.Snapshot
	log     *zap.Logger
	scoreFn ScoreFunc
}

// NewSampler creates a new Sampler. scoreFn must not be nil.
func NewSampler(pg *store.PG, rt *runtime.Snapshot, log *zap.Logger, scoreFn ScoreFunc) *Sampler {
	return &Sampler{pg: pg, rt: rt, log: log, scoreFn: scoreFn}
}

// Run blocks until ctx is cancelled. It primes one sample immediately on
// start so the database is populated before the first tick fires.
func (s *Sampler) Run(ctx context.Context) {
	tick := time.NewTicker(s.interval())
	defer tick.Stop()
	// Prime immediately — mirrors pressure.Sampler.Run.
	_ = s.sampleOnce(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			_ = s.sampleOnce(ctx)
			// Hot-reload interval in case an operator changed the config key.
			if d := s.interval(); d > 0 {
				tick.Reset(d)
			}
		}
	}
}

// interval reads durability.sample_interval_seconds from the runtime config
// (hot-reloaded). Default 300 s; minimum 30 s.
func (s *Sampler) interval() time.Duration {
	secs := 300
	if s.rt != nil {
		v := s.rt.Float("durability.sample_interval_seconds", 300)
		secs = int(v)
	}
	if secs < 30 {
		secs = 30
	}
	return time.Duration(secs) * time.Second
}

// sampleOnce iterates over all enabled clusters, computes their score, and
// persists a snapshot. Per-cluster errors are logged and skipped so a single
// unreachable cluster does not block the rest.
func (s *Sampler) sampleOnce(ctx context.Context) error {
	clusters, err := s.pg.ListClusters(ctx)
	if err != nil {
		s.log.Warn("durability: list clusters", zap.Error(err))
		return err
	}
	for i := range clusters {
		cl := &clusters[i]
		if !cl.Enabled {
			continue
		}
		score, components, err := s.scoreFn(ctx, cl)
		if err != nil {
			s.log.Warn("durability: compute score",
				zap.String("cluster", cl.Name), zap.Error(err))
			continue
		}
		raw, err := encodeComponents(components)
		if err != nil {
			s.log.Warn("durability: encode components",
				zap.String("cluster", cl.Name), zap.Error(err))
			continue
		}
		if err := s.pg.InsertScoreSnapshot(ctx, cl.ID, score, raw); err != nil {
			s.log.Warn("durability: persist snapshot",
				zap.String("cluster", cl.Name), zap.Error(err))
		}
	}
	return nil
}

func encodeComponents(c map[string]float64) ([]byte, error) {
	if len(c) == 0 {
		return []byte("{}"), nil
	}
	return json.Marshal(c)
}
