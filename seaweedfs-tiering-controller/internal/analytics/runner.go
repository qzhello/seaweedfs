package analytics

import (
	"context"
	"fmt"
	"time"

	"go.uber.org/zap"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/seaweed"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// Runner schedules pattern + cohort snapshots. One pass:
//   1. List volumes from SeaweedFS master.
//   2. Resolve each volume's business_domain via PG resource_tags (collection scope).
//   3. Pull 168h hourly reads from CH per volume.
//   4. Detect cyclical pattern + Z-score within cohort.
//   5. Write back to CH (volume_pattern + cohort_baseline).
//
// The runner is intentionally idempotent — re-running on the same data just
// overwrites the latest snapshot via ReplacingMergeTree.
type Runner struct {
	pg       *store.PG
	ch       *store.CH
	sw       *seaweed.Client
	log      *zap.Logger
	interval time.Duration
}

// NewRunner constructs the runner. interval=0 makes it on-demand only.
func NewRunner(pg *store.PG, ch *store.CH, sw *seaweed.Client, log *zap.Logger, interval time.Duration) *Runner {
	return &Runner{pg: pg, ch: ch, sw: sw, log: log, interval: interval}
}

// Run blocks until ctx is cancelled, firing one pass on start and then every
// interval. Errors are logged but never abort the loop — pattern snapshots
// are best-effort.
func (r *Runner) Run(ctx context.Context) {
	if r.interval <= 0 {
		r.log.Info("analytics runner disabled (interval=0)")
		return
	}
	if err := r.OnePass(ctx); err != nil {
		r.log.Warn("analytics initial pass", zap.Error(err))
	}
	t := time.NewTicker(r.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := r.OnePass(ctx); err != nil {
				r.log.Warn("analytics pass", zap.Error(err))
			}
		}
	}
}

// OnePass executes a single snapshot. Exposed so the API can trigger it
// on-demand from the operator dashboard.
func (r *Runner) OnePass(ctx context.Context) error {
	startedAt := time.Now()

	volumes, err := r.sw.ListVolumes(ctx)
	if err != nil {
		return fmt.Errorf("list volumes: %w", err)
	}

	// Build a collection→business_domain lookup once per pass. This pulls
	// every cluster's tags; a single call is cheaper than per-volume lookup.
	collectionDomain, err := r.collectionDomainMap(ctx)
	if err != nil {
		return fmt.Errorf("domain map: %w", err)
	}

	// Step 1+2+3: detect pattern per volume.
	hourly := 168
	since := time.Now().Add(-time.Duration(hourly) * time.Hour)
	rows := make([]CohortRow, 0, len(volumes))
	for _, v := range volumes {
		if err := ctx.Err(); err != nil {
			return err
		}
		series, err := r.ch.HourlyReads(ctx, v.ID, since, hourly)
		if err != nil {
			r.log.Debug("hourly reads", zap.Uint32("volume", v.ID), zap.Error(err))
			series = make([]uint32, hourly) // treat as silent
		}
		domain := "other"
		if d, ok := collectionDomain[v.Collection]; ok && d != "" {
			domain = d
		}
		rows = append(rows, CohortRow{
			VolumeID:       v.ID,
			BusinessDomain: domain,
			SizeBytes:      v.Size,
			Pattern:        Detect(v.ID, series),
		})
	}

	// Step 4: cohort z-score within business_domain.
	scored, baselines := ScoreCohorts(rows)

	// Step 5: persist.
	patternRows := make([]store.PatternRow, len(scored))
	for i, s := range scored {
		patternRows[i] = store.PatternRow{
			VolumeID:       s.VolumeID,
			BusinessDomain: s.BusinessDomain,
			ACF24h:         s.Pattern.ACF24h,
			ACF168h:        s.Pattern.ACF168h,
			CycleKind:      string(s.Pattern.Kind),
			Reads7d:        s.Pattern.Reads7d,
			ReadsPerByte7d: s.ReadsPerByte7d,
			CohortZReads:   s.CohortZReads,
			Sparkline168h:  s.Pattern.Sparkline168h,
		}
	}
	if err := r.ch.PutPatterns(ctx, patternRows); err != nil {
		return fmt.Errorf("put patterns: %w", err)
	}

	baselineRows := make([]store.CohortBaselineRow, len(baselines))
	for i, b := range baselines {
		baselineRows[i] = store.CohortBaselineRow{
			BusinessDomain:     b.BusinessDomain,
			VolumeCount:        b.VolumeCount,
			MeanReadsPerByte:   b.MeanReadsPerByte,
			StddevReadsPerByte: b.StddevReadsPerByte,
			P50Reads:           b.P50Reads,
			P95Reads:           b.P95Reads,
		}
	}
	if err := r.ch.PutCohortBaselines(ctx, baselineRows); err != nil {
		return fmt.Errorf("put baselines: %w", err)
	}

	r.log.Info("analytics pass complete",
		zap.Int("volumes", len(volumes)),
		zap.Int("cohorts", len(baselines)),
		zap.Duration("took", time.Since(startedAt)))
	return nil
}

// collectionDomainMap builds collection-name → business_domain by scanning
// every cluster's resource_tags. The cluster.business_domain serves as the
// fallback for collections without an explicit tag.
func (r *Runner) collectionDomainMap(ctx context.Context) (map[string]string, error) {
	clusters, err := r.pg.ListClusters(ctx)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, c := range clusters {
		tags, err := r.pg.ListTags(ctx, c.ID)
		if err != nil {
			r.log.Warn("list tags", zap.String("cluster", c.Name), zap.Error(err))
			continue
		}
		for _, t := range tags {
			if t.ScopeKind == "collection" && t.ScopeValue != "" && t.BusinessDomain != "" {
				out[t.ScopeValue] = t.BusinessDomain
			}
		}
		// Cluster-level domain becomes the catch-all under a synthetic "*" key
		// so callers can fallback when a collection tag is missing.
		if c.BusinessDomain != "" {
			out["__cluster_default__"] = c.BusinessDomain
		}
	}
	return out, nil
}
