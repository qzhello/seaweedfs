// Package collector contains the periodic background workers that
// shape the controller's "memory" — currently a single feature-snapshot
// runner that walks every enabled cluster's topology, joins it with
// ClickHouse read aggregates, and writes one row per volume into
// tiering.volume_features.
//
// The snapshot table is time-series (see migrations/clickhouse/005),
// so each tick adds a new horizontal slice. Time-machine policy
// simulation, postmortem trend charts, and AI prompt enrichment all
// read from it.
//
// Cadence default is 5m, override via config. The runner is best-effort
// — partial cluster failures log and continue. A failed write does not
// block the next tick.
package collector

import (
	"context"
	"time"

	"go.uber.org/zap"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/seaweed"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

const (
	defaultInterval = 5 * time.Minute
	// Cap a single tick's batch size so we don't blow up CH memory if
	// the cluster ever explodes to a million volumes. 50k volumes per
	// batch ≈ 5 MB on the wire — plenty of headroom.
	maxBatchSize = 50_000
)

// FeatureRunner walks enabled clusters and refreshes the volume_features
// time-series snapshot. Safe to run as a single goroutine — there is no
// internal concurrency.
type FeatureRunner struct {
	pg       *store.PG
	ch       *store.CH
	sw       *seaweed.Client
	log      *zap.Logger
	interval time.Duration
}

func NewFeatureRunner(pg *store.PG, ch *store.CH, sw *seaweed.Client, log *zap.Logger, interval time.Duration) *FeatureRunner {
	if interval <= 0 {
		interval = defaultInterval
	}
	return &FeatureRunner{pg: pg, ch: ch, sw: sw, log: log, interval: interval}
}

func (r *FeatureRunner) Run(ctx context.Context) {
	// Kick off one immediate tick so the first snapshot lands quickly
	// instead of waiting a full interval. Without this an operator
	// restarting the controller would see an empty trend chart for 5+m.
	r.tickOnce(ctx)
	t := time.NewTicker(r.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			r.tickOnce(ctx)
		}
	}
}

func (r *FeatureRunner) tickOnce(ctx context.Context) {
	start := time.Now()
	clusters, err := r.pg.ListClusters(ctx)
	if err != nil {
		r.log.Warn("feature collector: list clusters", zap.Error(err))
		return
	}
	// Snapshot read aggregates once per tick — CH is a single backend
	// that holds aggregates for all clusters together, so we save N
	// round trips by hoisting the query out of the per-cluster loop.
	aggs, err := r.ch.VolumeReadAggregates(ctx)
	if err != nil {
		r.log.Warn("feature collector: read aggregates", zap.Error(err))
		aggs = map[uint32]store.VolumeReadAggregate{}
	}

	written := 0
	for _, c := range clusters {
		if !c.Enabled {
			continue
		}
		n, err := r.snapshotCluster(ctx, c, aggs)
		if err != nil {
			r.log.Warn("feature collector: cluster",
				zap.String("name", c.Name), zap.Error(err))
			continue
		}
		written += n
	}
	// Fallback for "no clusters registered" — single-master MVP mode.
	if len(clusters) == 0 {
		n, err := r.snapshotCluster(ctx, store.Cluster{Name: "default"}, aggs)
		if err != nil {
			r.log.Warn("feature collector: default cluster", zap.Error(err))
		}
		written += n
	}
	r.log.Info("feature collector tick",
		zap.Int("volumes_written", written),
		zap.Duration("took", time.Since(start)))
}

func (r *FeatureRunner) snapshotCluster(ctx context.Context, c store.Cluster, aggs map[uint32]store.VolumeReadAggregate) (int, error) {
	vols, err := r.sw.ListVolumesAt(ctx, c.MasterAddr)
	if err != nil {
		return 0, err
	}
	now := time.Now()
	feats := make([]store.VolumeFeatures, 0, len(vols))
	// Per-volume rows may duplicate when replication factor > 1. Keep
	// only the first one (any replica's stats are equivalent for our
	// purposes — they share the same volume_id and reads).
	seen := map[uint32]struct{}{}
	for _, v := range vols {
		if v.IsEC {
			// EC volumes have shard rows; the data path for them lives
			// elsewhere and reads_30d here would be misleading. Skip.
			continue
		}
		if _, dup := seen[v.ID]; dup {
			continue
		}
		seen[v.ID] = struct{}{}

		f := store.VolumeFeatures{
			VolumeID:   v.ID,
			Collection: v.Collection,
			SizeBytes:  v.Size,
			IsReadonly: v.ReadOnly,
		}
		// Quiet duration = now - last modified. ModifiedAtSec=0 means
		// the master never reported a write, which we surface as a very
		// large value so policies can match "untouched since birth".
		if v.ModifiedAtSec > 0 {
			diff := now.Unix() - v.ModifiedAtSec
			if diff < 0 {
				diff = 0
			}
			f.QuietForSeconds = uint64(diff)
		} else {
			f.QuietForSeconds = uint64(now.Unix())
		}

		if a, ok := aggs[v.ID]; ok {
			f.Reads7d = a.Reads7d
			f.Reads30d = a.Reads30d
			f.Writes30d = a.Writes30d
			f.UniqueKeys30d = a.UniqueKeys30d
			// last_access_seconds from CH wins when present — it's
			// finer-grained than ModifiedAtSec (which is volume-level).
			if a.LastAccessSeconds > 0 {
				f.LastAccessSecs = a.LastAccessSeconds
			}
		}

		feats = append(feats, f)
		if len(feats) >= maxBatchSize {
			break
		}
	}
	if len(feats) == 0 {
		return 0, nil
	}
	if err := r.ch.PutVolumeFeatures(ctx, feats); err != nil {
		return 0, err
	}
	return len(feats), nil
}
