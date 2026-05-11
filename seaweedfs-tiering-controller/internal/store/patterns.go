package store

import (
	"context"
	"fmt"
	"time"
)

// HourlyReads pulls a chronological hourly read series for one volume,
// padding missing buckets with zero so the analytics layer can do exact
// lag-based autocorrelation without index gaps.
//
// `since` is inclusive; `hours` is the expected length. The returned slice is
// guaranteed to be exactly `hours` long.
func (c *CH) HourlyReads(ctx context.Context, volumeID uint32, since time.Time, hours int) ([]uint32, error) {
	if hours <= 0 || hours > 24*30 {
		return nil, fmt.Errorf("hours out of range: %d", hours)
	}
	rows, err := c.Conn.Query(ctx, `
		SELECT toStartOfHour(hour) AS h, sum(reads)
		FROM tiering.volume_stats_hourly
		WHERE volume_id = ? AND hour >= ?
		GROUP BY h
		ORDER BY h`, volumeID, since.Truncate(time.Hour))
	if err != nil {
		return nil, fmt.Errorf("hourly reads query: %w", err)
	}
	defer rows.Close()

	// Map bucket → reads, then walk a fixed-length window aligned to `since`.
	got := map[int64]uint64{}
	for rows.Next() {
		var h time.Time
		var r uint64
		if err := rows.Scan(&h, &r); err != nil {
			return nil, fmt.Errorf("scan hourly: %w", err)
		}
		got[h.UTC().Unix()] = r
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]uint32, hours)
	base := since.Truncate(time.Hour).UTC().Unix()
	for i := 0; i < hours; i++ {
		ts := base + int64(i)*3600
		if v, ok := got[ts]; ok {
			// Clamp to uint32 max; reads/hour beyond 4B is unrealistic and
			// would overflow downstream math anyway.
			if v > 0xFFFFFFFF {
				v = 0xFFFFFFFF
			}
			out[i] = uint32(v)
		}
	}
	return out, nil
}

// PatternRow is what the controller writes back to volume_pattern.
type PatternRow struct {
	VolumeID       uint32
	BusinessDomain string
	ACF24h         float32
	ACF168h        float32
	CycleKind      string
	Reads7d        uint64
	ReadsPerByte7d float64
	CohortZReads   float32
	Sparkline168h  []uint32
}

func (c *CH) PutPatterns(ctx context.Context, rows []PatternRow) error {
	if len(rows) == 0 {
		return nil
	}
	batch, err := c.Conn.PrepareBatch(ctx, `INSERT INTO tiering.volume_pattern`)
	if err != nil {
		return fmt.Errorf("prepare patterns batch: %w", err)
	}
	now := time.Now()
	for _, r := range rows {
		spark := r.Sparkline168h
		if spark == nil {
			spark = []uint32{}
		}
		if err := batch.Append(now, r.VolumeID, r.BusinessDomain,
			r.ACF24h, r.ACF168h, r.CycleKind,
			r.Reads7d, r.ReadsPerByte7d, r.CohortZReads, spark); err != nil {
			return fmt.Errorf("append pattern: %w", err)
		}
	}
	if err := batch.Send(); err != nil {
		return fmt.Errorf("send patterns batch: %w", err)
	}
	return nil
}

// CohortBaselineRow mirrors analytics.CohortBaseline for CH writes.
type CohortBaselineRow struct {
	BusinessDomain     string
	VolumeCount        uint32
	MeanReadsPerByte   float64
	StddevReadsPerByte float64
	P50Reads           uint64
	P95Reads           uint64
}

func (c *CH) PutCohortBaselines(ctx context.Context, rows []CohortBaselineRow) error {
	if len(rows) == 0 {
		return nil
	}
	batch, err := c.Conn.PrepareBatch(ctx, `INSERT INTO tiering.cohort_baseline`)
	if err != nil {
		return fmt.Errorf("prepare baselines batch: %w", err)
	}
	now := time.Now()
	for _, r := range rows {
		if err := batch.Append(now, r.BusinessDomain, r.VolumeCount,
			r.MeanReadsPerByte, r.StddevReadsPerByte, r.P50Reads, r.P95Reads); err != nil {
			return fmt.Errorf("append baseline: %w", err)
		}
	}
	if err := batch.Send(); err != nil {
		return fmt.Errorf("send baselines batch: %w", err)
	}
	return nil
}

// ReadsSince returns total reads + bytes for a volume since `since`. Used by
// the AI review labeler to test whether a tiered volume re-warmed.
func (c *CH) ReadsSince(ctx context.Context, volumeID uint32, since time.Time) (reads int64, bytes int64, err error) {
	row := c.Conn.QueryRow(ctx, `
		SELECT COALESCE(sum(reads), 0) AS reads, COALESCE(sum(bytes_read), 0) AS bytes
		FROM tiering.volume_stats_hourly
		WHERE volume_id = ? AND hour >= ?`, volumeID, since.Truncate(time.Hour))
	var r, b uint64
	if err := row.Scan(&r, &b); err != nil {
		return 0, 0, fmt.Errorf("reads since: %w", err)
	}
	return int64(r), int64(b), nil
}

// LatestPattern returns the most recent fingerprint for a volume — used by
// the volume profile page and by the scorer's bonus/penalty logic.
func (c *CH) LatestPattern(ctx context.Context, volumeID uint32) (*PatternRow, error) {
	row := c.Conn.QueryRow(ctx, `
		SELECT volume_id, business_domain, acf_24h, acf_168h, cycle_kind,
		       reads_7d, reads_per_byte_7d, cohort_z_reads, sparkline_168h
		FROM tiering.volume_pattern FINAL
		WHERE volume_id = ?`, volumeID)
	var p PatternRow
	if err := row.Scan(&p.VolumeID, &p.BusinessDomain, &p.ACF24h, &p.ACF168h, &p.CycleKind,
		&p.Reads7d, &p.ReadsPerByte7d, &p.CohortZReads, &p.Sparkline168h); err != nil {
		return nil, fmt.Errorf("scan pattern: %w", err)
	}
	return &p, nil
}

// AnomalyRow is a flat representation of a flagged volume — enough for the
// cohort overview to render without a second round-trip.
type AnomalyRow struct {
	VolumeID       uint32  `json:"volume_id"`
	BusinessDomain string  `json:"business_domain"`
	CycleKind      string  `json:"cycle_kind"`
	Reads7d        uint64  `json:"reads_7d"`
	ReadsPerByte7d float64 `json:"reads_per_byte_7d"`
	CohortZReads   float32 `json:"cohort_z_reads"`
}

// ListAnomalies returns volumes whose |cohort z-score| meets the threshold,
// optionally filtered to a specific business_domain. Ordered by |z| desc so
// the worst offenders surface first; capped at limit (default 50).
func (c *CH) ListAnomalies(ctx context.Context, domain string, threshold float32, limit int) ([]AnomalyRow, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	if threshold <= 0 {
		threshold = 3.0
	}
	q := `
		SELECT volume_id, business_domain, cycle_kind, reads_7d, reads_per_byte_7d, cohort_z_reads
		FROM tiering.volume_pattern FINAL
		WHERE abs(cohort_z_reads) >= ?`
	args := []any{threshold}
	if domain != "" {
		q += ` AND business_domain = ?`
		args = append(args, domain)
	}
	q += ` ORDER BY abs(cohort_z_reads) DESC LIMIT ?`
	args = append(args, limit)
	rows, err := c.Conn.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("anomalies query: %w", err)
	}
	defer rows.Close()
	out := []AnomalyRow{}
	for rows.Next() {
		var r AnomalyRow
		if err := rows.Scan(&r.VolumeID, &r.BusinessDomain, &r.CycleKind,
			&r.Reads7d, &r.ReadsPerByte7d, &r.CohortZReads); err != nil {
			return nil, fmt.Errorf("scan anomaly: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// CohortKindBreakdown returns per-domain counts of each cycle kind. Powers
// the colored bar on each cohort overview card.
type CohortKindBreakdown struct {
	BusinessDomain string         `json:"business_domain"`
	Counts         map[string]int `json:"counts"` // cycle_kind → volume count
}

func (c *CH) CohortKindBreakdown(ctx context.Context) ([]CohortKindBreakdown, error) {
	rows, err := c.Conn.Query(ctx, `
		SELECT business_domain, cycle_kind, count() AS n
		FROM tiering.volume_pattern FINAL
		GROUP BY business_domain, cycle_kind
		ORDER BY business_domain`)
	if err != nil {
		return nil, fmt.Errorf("cohort kind query: %w", err)
	}
	defer rows.Close()
	by := map[string]map[string]int{}
	for rows.Next() {
		var dom, kind string
		var n uint64
		if err := rows.Scan(&dom, &kind, &n); err != nil {
			return nil, fmt.Errorf("scan kind: %w", err)
		}
		if by[dom] == nil {
			by[dom] = map[string]int{}
		}
		by[dom][kind] = int(n)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]CohortKindBreakdown, 0, len(by))
	for dom, counts := range by {
		out = append(out, CohortKindBreakdown{BusinessDomain: dom, Counts: counts})
	}
	return out, nil
}

// LatestCohortBaselines returns one row per domain with the most recent
// snapshot.
func (c *CH) LatestCohortBaselines(ctx context.Context) ([]CohortBaselineRow, error) {
	rows, err := c.Conn.Query(ctx, `
		SELECT business_domain, volume_count, mean_reads_per_byte, stddev_reads_per_byte,
		       p50_reads, p95_reads
		FROM tiering.cohort_baseline FINAL
		ORDER BY business_domain`)
	if err != nil {
		return nil, fmt.Errorf("baselines query: %w", err)
	}
	defer rows.Close()
	out := []CohortBaselineRow{}
	for rows.Next() {
		var b CohortBaselineRow
		if err := rows.Scan(&b.BusinessDomain, &b.VolumeCount, &b.MeanReadsPerByte,
			&b.StddevReadsPerByte, &b.P50Reads, &b.P95Reads); err != nil {
			return nil, fmt.Errorf("scan baseline: %w", err)
		}
		out = append(out, b)
	}
	return out, rows.Err()
}
