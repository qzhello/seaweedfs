package api

// LifecycleScanRunner periodically walks every governed bucket and
// refreshes its "expired data" counters, so the lifecycle monitoring
// surfaces stay current without an operator clicking Scan per bucket.
//
// It lives in package api (not its own package) because the filer walker
// it reuses — scanBucketExpired / newPathWalker — is package-private
// here; extracting it would mean a riskier multi-file refactor.

import (
	"context"
	"time"

	"go.uber.org/zap"
)

type LifecycleScanRunner struct {
	d        Deps
	interval time.Duration
	log      *zap.Logger
}

// NewLifecycleScanRunner builds the runner. A sub-minute interval is
// rejected — filer walks are heavy and retention is a days-scale signal.
func NewLifecycleScanRunner(d Deps, interval time.Duration) *LifecycleScanRunner {
	if interval < time.Minute {
		interval = 6 * time.Hour
	}
	return &LifecycleScanRunner{d: d, interval: interval, log: d.Log}
}

// Run blocks until ctx is cancelled, scanning once immediately and then
// every interval.
func (r *LifecycleScanRunner) Run(ctx context.Context) {
	if r.log != nil {
		r.log.Info("lifecycle scan runner started", zap.Duration("interval", r.interval))
	}
	r.tick(ctx)
	t := time.NewTicker(r.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			r.tick(ctx)
		}
	}
}

// tick scans every governed bucket on every enabled cluster. Best-effort
// throughout: one bucket's failure never blocks the rest.
func (r *LifecycleScanRunner) tick(ctx context.Context) {
	clusters, err := r.d.PG.ListClusters(ctx)
	if err != nil {
		r.warn("lifecycle scan: list clusters", zap.Error(err))
		return
	}
	scanned, withExpired := 0, 0
	for i := range clusters {
		cl := clusters[i]
		if !cl.Enabled {
			continue
		}
		gov, gerr := r.d.PG.ListBucketGovernance(ctx, cl.ID)
		if gerr != nil {
			r.warn("lifecycle scan: list governance",
				zap.String("cluster", cl.Name), zap.Error(gerr))
			continue
		}
		for bucket, g := range gov {
			if g.RetentionDays == nil {
				continue
			}
			if ctx.Err() != nil {
				return
			}
			objects, totalBytes, truncated, sample, serr := scanBucketExpired(ctx, r.d, &cl, bucket, *g.RetentionDays)
			if serr != nil {
				r.warn("lifecycle scan: bucket walk",
					zap.String("cluster", cl.Name), zap.String("bucket", bucket), zap.Error(serr))
				continue
			}
			if rerr := r.d.PG.RecordBucketScan(ctx, cl.ID, bucket, objects, totalBytes, truncated, sample); rerr != nil {
				r.warn("lifecycle scan: record", zap.String("bucket", bucket), zap.Error(rerr))
				continue
			}
			scanned++
			if objects > 0 {
				withExpired++
			}
		}
	}
	if scanned > 0 && r.log != nil {
		r.log.Info("lifecycle scan pass complete",
			zap.Int("buckets_scanned", scanned),
			zap.Int("buckets_with_expired", withExpired))
	}
}

func (r *LifecycleScanRunner) warn(msg string, fields ...zap.Field) {
	if r.log != nil {
		r.log.Warn(msg, fields...)
	}
}
