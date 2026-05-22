package store

import (
	"context"
	"fmt"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

type CH struct {
	Conn driver.Conn
}

func NewCH(ctx context.Context, addrs []string, db, user, pwd string) (*CH, error) {
	conn, err := clickhouse.Open(&clickhouse.Options{
		Addr: addrs,
		Auth: clickhouse.Auth{Database: db, Username: user, Password: pwd},
		Settings: clickhouse.Settings{
			"max_execution_time": 30,
		},
		DialTimeout: 5 * time.Second,
	})
	if err != nil {
		return nil, fmt.Errorf("open clickhouse: %w", err)
	}
	if err := conn.Ping(ctx); err != nil {
		return nil, fmt.Errorf("ping clickhouse: %w", err)
	}
	return &CH{Conn: conn}, nil
}

func (c *CH) Close() error { return c.Conn.Close() }

// VolumeHeatmap returns hourly read counts for a window. Used by the heatmap UI.
type HeatPoint struct {
	Hour     time.Time `json:"hour"`
	VolumeID uint32    `json:"volume_id"`
	Reads    uint64    `json:"reads"`
}

func (c *CH) VolumeHeatmap(ctx context.Context, since time.Time, limit int) ([]HeatPoint, error) {
	rows, err := c.Conn.Query(ctx, `
		SELECT hour, volume_id, sum(reads) AS reads
		FROM tiering.volume_stats_hourly
		WHERE hour >= ?
		GROUP BY hour, volume_id
		ORDER BY hour
		LIMIT ?`, since, limit)
	if err != nil {
		return nil, fmt.Errorf("heatmap query: %w", err)
	}
	defer rows.Close()
	out := []HeatPoint{}
	for rows.Next() {
		var h HeatPoint
		if err := rows.Scan(&h.Hour, &h.VolumeID, &h.Reads); err != nil {
			return nil, fmt.Errorf("scan heatmap: %w", err)
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// VolumeFeatures returns the latest snapshot of a volume's scoring features.
type VolumeFeatures struct {
	VolumeID         uint32  `json:"volume_id"`
	Collection       string  `json:"collection"`
	SizeBytes        uint64  `json:"size_bytes"`
	IsReadonly       bool    `json:"is_readonly"`
	QuietForSeconds  uint64  `json:"quiet_for_seconds"`
	LastAccessSecs   uint64  `json:"last_access_seconds"`
	Reads7d          uint64  `json:"reads_7d"`
	Reads30d         uint64  `json:"reads_30d"`
	Writes30d        uint64  `json:"writes_30d"`
	UniqueKeys30d    uint64  `json:"unique_keys_30d"`
}

func (c *CH) LatestVolumeFeatures(ctx context.Context, volumeID uint32) (*VolumeFeatures, error) {
	row := c.Conn.QueryRow(ctx, `
		SELECT volume_id, collection, size_bytes, is_readonly, quiet_for_seconds,
		       last_access_seconds, reads_7d, reads_30d, writes_30d, unique_keys_30d
		FROM tiering.volume_features
		WHERE volume_id = ?
		ORDER BY snapshot_at DESC
		LIMIT 1`, volumeID)
	var f VolumeFeatures
	var ro uint8
	if err := row.Scan(&f.VolumeID, &f.Collection, &f.SizeBytes, &ro, &f.QuietForSeconds,
		&f.LastAccessSecs, &f.Reads7d, &f.Reads30d, &f.Writes30d, &f.UniqueKeys30d); err != nil {
		return nil, fmt.Errorf("scan features: %w", err)
	}
	f.IsReadonly = ro == 1
	return &f, nil
}

// VolumeFeaturesAt returns the most recent feature snapshot at or
// before `at` — the time-machine primitive. Returns nil if no snapshot
// exists for that window (caller decides whether to fall back).
func (c *CH) VolumeFeaturesAt(ctx context.Context, volumeID uint32, at time.Time) (*VolumeFeatures, error) {
	row := c.Conn.QueryRow(ctx, `
		SELECT volume_id, collection, size_bytes, is_readonly, quiet_for_seconds,
		       last_access_seconds, reads_7d, reads_30d, writes_30d, unique_keys_30d
		FROM tiering.volume_features
		WHERE volume_id = ? AND snapshot_at <= ?
		ORDER BY snapshot_at DESC
		LIMIT 1`, volumeID, at)
	var f VolumeFeatures
	var ro uint8
	if err := row.Scan(&f.VolumeID, &f.Collection, &f.SizeBytes, &ro, &f.QuietForSeconds,
		&f.LastAccessSecs, &f.Reads7d, &f.Reads30d, &f.Writes30d, &f.UniqueKeys30d); err != nil {
		return nil, fmt.Errorf("scan features at: %w", err)
	}
	f.IsReadonly = ro == 1
	return &f, nil
}

// VolumeFeatureTrend returns up to `limit` (defaults to ~90) historical
// snapshots for a single volume, oldest first. Powers the per-volume
// trend sparkline used in postmortem / inspector UIs.
type VolumeFeatureSample struct {
	SnapshotAt time.Time `json:"snapshot_at"`
	SizeBytes  uint64    `json:"size_bytes"`
	Reads7d    uint64    `json:"reads_7d"`
	Reads30d   uint64    `json:"reads_30d"`
	QuietDays  uint64    `json:"quiet_days"`
}

func (c *CH) VolumeFeatureTrend(ctx context.Context, volumeID uint32, since time.Time, limit int) ([]VolumeFeatureSample, error) {
	if limit <= 0 || limit > 2000 {
		limit = 500
	}
	rows, err := c.Conn.Query(ctx, `
		SELECT snapshot_at, size_bytes, reads_7d, reads_30d,
		       intDiv(quiet_for_seconds, 86400) AS quiet_days
		FROM tiering.volume_features
		WHERE volume_id = ? AND snapshot_at >= ?
		ORDER BY snapshot_at
		LIMIT ?`, volumeID, since, limit)
	if err != nil {
		return nil, fmt.Errorf("trend query: %w", err)
	}
	defer rows.Close()
	out := []VolumeFeatureSample{}
	for rows.Next() {
		var s VolumeFeatureSample
		if err := rows.Scan(&s.SnapshotAt, &s.SizeBytes, &s.Reads7d, &s.Reads30d, &s.QuietDays); err != nil {
			return nil, fmt.Errorf("scan trend: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// VolumeFeatureDailyPoint is one downsampled day of a volume's feature
// history — the day's final size and that day's peak 7-day read count.
type VolumeFeatureDailyPoint struct {
	Day       time.Time `json:"day"`
	SizeBytes uint64    `json:"size_bytes"`
	Reads7d   uint64    `json:"reads_7d"`
}

// VolumeFeatureTrendBulk returns daily-downsampled feature history for the
// given volumes since `since`, keyed by volume id, oldest-first. One query
// backs every sparkline on the volumes list page: collapsing the 5-minute
// snapshots to one row per (volume, day) keeps the payload bounded (≤90
// points/volume) no matter how often the collector runs.
func (c *CH) VolumeFeatureTrendBulk(ctx context.Context, volumeIDs []uint32, since time.Time) (map[uint32][]VolumeFeatureDailyPoint, error) {
	out := map[uint32][]VolumeFeatureDailyPoint{}
	if len(volumeIDs) == 0 {
		return out, nil
	}
	rows, err := c.Conn.Query(ctx, `
		SELECT volume_id,
		       toDate(snapshot_at)             AS day,
		       argMax(size_bytes, snapshot_at) AS size_bytes,
		       max(reads_7d)                   AS reads_7d
		FROM tiering.volume_features
		WHERE volume_id IN (?) AND snapshot_at >= ?
		GROUP BY volume_id, day
		ORDER BY volume_id, day`, volumeIDs, since)
	if err != nil {
		return nil, fmt.Errorf("trend bulk query: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var vid uint32
		var p VolumeFeatureDailyPoint
		if err := rows.Scan(&vid, &p.Day, &p.SizeBytes, &p.Reads7d); err != nil {
			return nil, fmt.Errorf("scan trend bulk: %w", err)
		}
		out[vid] = append(out[vid], p)
	}
	return out, rows.Err()
}

// VolumeFeaturesSnapshotAt reconstructs every volume's feature snapshot as
// of `at` — the most recent row at or before `at` for each volume. Powers
// the policy simulator's time-machine mode: volume_features IS the
// historical topology, since size / quiet_for_seconds / reads were all
// recorded at snapshot time, so no "now" reconstruction is needed.
func (c *CH) VolumeFeaturesSnapshotAt(ctx context.Context, at time.Time) (map[uint32]VolumeFeatures, error) {
	rows, err := c.Conn.Query(ctx, `
		SELECT volume_id, collection, size_bytes, is_readonly, quiet_for_seconds,
		       last_access_seconds, reads_7d, reads_30d, writes_30d, unique_keys_30d
		FROM tiering.volume_features
		WHERE snapshot_at <= ?
		ORDER BY volume_id, snapshot_at DESC
		LIMIT 1 BY volume_id`, at)
	if err != nil {
		return nil, fmt.Errorf("snapshot-at query: %w", err)
	}
	defer rows.Close()
	out := map[uint32]VolumeFeatures{}
	for rows.Next() {
		var f VolumeFeatures
		var ro uint8
		if err := rows.Scan(&f.VolumeID, &f.Collection, &f.SizeBytes, &ro, &f.QuietForSeconds,
			&f.LastAccessSecs, &f.Reads7d, &f.Reads30d, &f.Writes30d, &f.UniqueKeys30d); err != nil {
			return nil, fmt.Errorf("scan snapshot-at: %w", err)
		}
		f.IsReadonly = ro == 1
		out[f.VolumeID] = f
	}
	return out, rows.Err()
}

// VolumeReadAggregates pulls reads_7d / reads_30d / writes_30d /
// unique_keys_30d / last_access_seconds for many volumes in one round
// trip. Powers the feature collector — far cheaper than N point queries.
type VolumeReadAggregate struct {
	VolumeID         uint32
	Reads7d          uint64
	Reads30d         uint64
	Writes30d        uint64
	UniqueKeys30d    uint64
	LastAccessSeconds uint64
}

func (c *CH) VolumeReadAggregates(ctx context.Context) (map[uint32]VolumeReadAggregate, error) {
	rows, err := c.Conn.Query(ctx, `
		SELECT
		    volume_id,
		    sumIf(reads, hour >= now() - INTERVAL 7 DAY)  AS reads_7d,
		    sumIf(reads, hour >= now() - INTERVAL 30 DAY) AS reads_30d,
		    sumIf(writes, hour >= now() - INTERVAL 30 DAY) AS writes_30d,
		    uniqMergeIf(unique_keys, hour >= now() - INTERVAL 30 DAY) AS unique_keys_30d,
		    toUInt64(dateDiff('second', max(hour), now()))           AS last_access_seconds
		FROM tiering.volume_stats_hourly
		WHERE hour >= now() - INTERVAL 30 DAY
		GROUP BY volume_id`)
	if err != nil {
		return nil, fmt.Errorf("aggregates query: %w", err)
	}
	defer rows.Close()
	out := map[uint32]VolumeReadAggregate{}
	for rows.Next() {
		var a VolumeReadAggregate
		if err := rows.Scan(&a.VolumeID, &a.Reads7d, &a.Reads30d, &a.Writes30d,
			&a.UniqueKeys30d, &a.LastAccessSeconds); err != nil {
			return nil, fmt.Errorf("scan aggregate: %w", err)
		}
		out[a.VolumeID] = a
	}
	return out, rows.Err()
}

// PutVolumeFeatures upserts a feature snapshot (called by the scorer pre-pass).
func (c *CH) PutVolumeFeatures(ctx context.Context, fs []VolumeFeatures) error {
	if len(fs) == 0 {
		return nil
	}
	batch, err := c.Conn.PrepareBatch(ctx, `INSERT INTO tiering.volume_features`)
	if err != nil {
		return fmt.Errorf("prepare features batch: %w", err)
	}
	now := time.Now()
	for _, f := range fs {
		ro := uint8(0)
		if f.IsReadonly {
			ro = 1
		}
		if err := batch.Append(now, f.VolumeID, f.Collection, f.SizeBytes, ro,
			f.QuietForSeconds, f.LastAccessSecs, f.Reads7d, f.Reads30d, f.Writes30d, f.UniqueKeys30d); err != nil {
			return fmt.Errorf("append features: %w", err)
		}
	}
	if err := batch.Send(); err != nil {
		return fmt.Errorf("send features batch: %w", err)
	}
	return nil
}

// ---- Temperature classification ----
//
// Temperature buckets are derived from the latest VolumeFeatures
// snapshot. Used by the Temperature dashboard to surface which
// collections have cooled down (and how much storage that represents)
// — the primary signal for tiering policy drafting.
//
// Bands, evaluated in order (first match wins):
//   hot    — reads_7d >= 50  OR quiet_for_seconds < 1h   (live traffic)
//   warm   — reads_7d  > 0   (any reads in 7d)
//   cool   — reads_7d == 0 AND reads_30d > 0             (recently gone quiet)
//   cold   — reads_30d == 0 AND quiet_for_seconds < 90d  (zero reads but recent)
//   frozen — quiet_for_seconds >= 90d                    (archival candidate)
//
// The thresholds are intentionally hard-coded for the first cut. A
// future iteration can hang them off a settings row so operators can
// tune per business domain.
const (
	TempHotReads      = 50
	TempHotQuietSec   = 3600
	TempFrozenSeconds = uint64(90 * 86400)
)

// CollectionTemperature is one row of the per-collection breakdown.
type CollectionTemperature struct {
	Collection string `json:"collection"`
	Volumes    uint64 `json:"volumes"`
	TotalSize  uint64 `json:"total_size"`
	Reads7d    uint64 `json:"reads_7d"`
	Reads30d   uint64 `json:"reads_30d"`
	HotN       uint64 `json:"hot_n"`
	HotSize    uint64 `json:"hot_size"`
	WarmN      uint64 `json:"warm_n"`
	WarmSize   uint64 `json:"warm_size"`
	CoolN      uint64 `json:"cool_n"`
	CoolSize   uint64 `json:"cool_size"`
	ColdN      uint64 `json:"cold_n"`
	ColdSize   uint64 `json:"cold_size"`
	FrozenN    uint64 `json:"frozen_n"`
	FrozenSize uint64 `json:"frozen_size"`
}

// temperatureBandsSQL returns the CASE expression that maps each row to
// a band name. Reused between the per-collection rollup and the
// per-volume drilldown so the classification stays consistent.
func temperatureBandsSQL() string {
	return fmt.Sprintf(`
        CASE
          WHEN reads_7d >= %d OR quiet_for_seconds < %d THEN 'hot'
          WHEN reads_7d > 0                              THEN 'warm'
          WHEN reads_7d = 0 AND reads_30d > 0            THEN 'cool'
          WHEN reads_30d = 0 AND quiet_for_seconds < %d  THEN 'cold'
          ELSE 'frozen'
        END`, TempHotReads, TempHotQuietSec, TempFrozenSeconds)
}

// CollectionTemperatures returns the temperature breakdown for every
// known collection, computed from the latest features snapshot.
func (c *CH) CollectionTemperatures(ctx context.Context) ([]CollectionTemperature, error) {
	// volume_features is a plain MergeTree time-series (one row per
	// snapshot) — FINAL is illegal on it and would not dedup anyway.
	// `latest` picks the newest snapshot per volume via LIMIT 1 BY.
	q := fmt.Sprintf(`
        WITH latest AS (
            SELECT volume_id, collection, size_bytes, reads_7d, reads_30d, quiet_for_seconds
            FROM tiering.volume_features
            ORDER BY volume_id, snapshot_at DESC
            LIMIT 1 BY volume_id
        ),
        base AS (
            SELECT collection, size_bytes, reads_7d, reads_30d, quiet_for_seconds,
                   %s AS band
            FROM latest
        )
        SELECT
          collection,
          count()                                AS volumes,
          sum(size_bytes)                        AS total_size,
          sum(reads_7d)                          AS reads_7d,
          sum(reads_30d)                         AS reads_30d,
          countIf(band='hot')                    AS hot_n,
          sumIf(size_bytes, band='hot')          AS hot_size,
          countIf(band='warm')                   AS warm_n,
          sumIf(size_bytes, band='warm')         AS warm_size,
          countIf(band='cool')                   AS cool_n,
          sumIf(size_bytes, band='cool')         AS cool_size,
          countIf(band='cold')                   AS cold_n,
          sumIf(size_bytes, band='cold')         AS cold_size,
          countIf(band='frozen')                 AS frozen_n,
          sumIf(size_bytes, band='frozen')       AS frozen_size
        FROM base
        GROUP BY collection
        ORDER BY total_size DESC`, temperatureBandsSQL())
	rows, err := c.Conn.Query(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("collection temps: %w", err)
	}
	defer rows.Close()
	out := []CollectionTemperature{}
	for rows.Next() {
		var r CollectionTemperature
		if err := rows.Scan(&r.Collection, &r.Volumes, &r.TotalSize, &r.Reads7d, &r.Reads30d,
			&r.HotN, &r.HotSize, &r.WarmN, &r.WarmSize, &r.CoolN, &r.CoolSize,
			&r.ColdN, &r.ColdSize, &r.FrozenN, &r.FrozenSize); err != nil {
			return nil, fmt.Errorf("scan collection temp: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// VolumeTemperature is one row of the per-volume drilldown within a
// collection. The band is the bucket label; size/quiet/reads are kept
// so the UI can tooltip the why behind each cell.
type VolumeTemperature struct {
	VolumeID        uint32 `json:"volume_id"`
	Collection      string `json:"collection"`
	Band            string `json:"band"`
	SizeBytes       uint64 `json:"size_bytes"`
	Reads7d         uint64 `json:"reads_7d"`
	Reads30d        uint64 `json:"reads_30d"`
	QuietForSeconds uint64 `json:"quiet_for_seconds"`
	IsReadonly      bool   `json:"is_readonly"`
}

// VolumeTemperatures returns the per-volume bands. `collection` is
// optional — empty string returns every volume. The result is capped
// at `limit` to avoid pushing tens of thousands of rows to the UI.
func (c *CH) VolumeTemperatures(ctx context.Context, collection string, limit int) ([]VolumeTemperature, error) {
	if limit <= 0 {
		limit = 5000
	}
	where := ""
	args := []any{}
	if collection != "" {
		where = " WHERE collection = ?"
		args = append(args, collection)
	}
	args = append(args, limit)
	// `latest` picks the newest snapshot per volume — see the note in
	// CollectionTemperatures on why FINAL can't be used here.
	q := fmt.Sprintf(`
        WITH latest AS (
            SELECT volume_id, collection, size_bytes, reads_7d, reads_30d,
                   quiet_for_seconds, is_readonly
            FROM tiering.volume_features
            ORDER BY volume_id, snapshot_at DESC
            LIMIT 1 BY volume_id
        )
        SELECT volume_id, collection, size_bytes, reads_7d, reads_30d,
               quiet_for_seconds, is_readonly, %s AS band
        FROM latest%s
        ORDER BY size_bytes DESC
        LIMIT ?`, temperatureBandsSQL(), where)
	rows, err := c.Conn.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("volume temps: %w", err)
	}
	defer rows.Close()
	out := []VolumeTemperature{}
	for rows.Next() {
		var v VolumeTemperature
		var ro uint8
		if err := rows.Scan(&v.VolumeID, &v.Collection, &v.SizeBytes, &v.Reads7d,
			&v.Reads30d, &v.QuietForSeconds, &ro, &v.Band); err != nil {
			return nil, fmt.Errorf("scan volume temp: %w", err)
		}
		v.IsReadonly = ro == 1
		out = append(out, v)
	}
	return out, rows.Err()
}

// ---- Gateway telemetry rollups ----
//
// Rows come from the gateway_bucket_daily MV (per-day aggregates) and
// gateway_object_recency (last-access per object). The Costs page +
// AI planner read these; the gateway writes raw events to
// gateway_events and ClickHouse keeps the MVs in sync.

// BucketAccessStat is one row of the bucket-level access summary.
type BucketAccessStat struct {
	Bucket          string  `json:"bucket"`
	Requests30d     uint64  `json:"requests_30d"`
	Reads30d        uint64  `json:"reads_30d"`
	Writes30d       uint64  `json:"writes_30d"`
	BytesOut30d     uint64  `json:"bytes_out_30d"`
	BytesIn30d      uint64  `json:"bytes_in_30d"`
	ReadWriteRatio  float64 `json:"read_write_ratio"`
	LastAccessSecs  int64   `json:"last_access_seconds"`
}

// BucketAccessSummary returns 30-day aggregates per bucket from the
// gateway daily rollup MV. Sorted by total requests desc so the most
// active buckets come first. limit caps the response (default 100).
func (c *CH) BucketAccessSummary(ctx context.Context, limit int) ([]BucketAccessStat, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := c.Conn.Query(ctx, `
        SELECT
          bucket,
          sum(requests)                                   AS requests_30d,
          sumIf(requests, operation = 'GET')              AS reads_30d,
          sumIf(requests, operation IN ('PUT','COMPLETE','UPLOAD_PART')) AS writes_30d,
          sum(bytes_out)                                  AS bytes_out_30d,
          sum(bytes_in)                                   AS bytes_in_30d
        FROM tiering.gateway_bucket_daily
        WHERE day >= today() - 30
        GROUP BY bucket
        ORDER BY requests_30d DESC
        LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("bucket access summary: %w", err)
	}
	defer rows.Close()
	out := []BucketAccessStat{}
	for rows.Next() {
		var b BucketAccessStat
		if err := rows.Scan(&b.Bucket, &b.Requests30d, &b.Reads30d, &b.Writes30d,
			&b.BytesOut30d, &b.BytesIn30d); err != nil {
			return nil, fmt.Errorf("scan bucket: %w", err)
		}
		if b.Writes30d > 0 {
			b.ReadWriteRatio = float64(b.Reads30d) / float64(b.Writes30d)
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// LastBucketAccessSeconds returns how long ago each listed bucket was
// last touched. Used by the AI planner to flag "no reads in N days"
// even when the bucket isn't in the daily rollup for the last day.
func (c *CH) LastBucketAccessSeconds(ctx context.Context, buckets []string) (map[string]int64, error) {
	out := map[string]int64{}
	if len(buckets) == 0 {
		return out, nil
	}
	rows, err := c.Conn.Query(ctx, `
        SELECT bucket, toUInt64(now() - max(ts)) AS quiet_for
          FROM tiering.gateway_events
         WHERE bucket IN (?)
         GROUP BY bucket`, buckets)
	if err != nil {
		return nil, fmt.Errorf("last access: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var b string
		var q uint64
		if err := rows.Scan(&b, &q); err != nil {
			return nil, err
		}
		out[b] = int64(q)
	}
	return out, rows.Err()
}

// AccessLogEvent is the row written by the collector.
type AccessLogEvent struct {
	TS           time.Time
	Bucket       string
	Collection   string
	VolumeID     uint32
	FileID       string
	Path         string
	Operation    string
	ObjectSize   uint64
	BytesSent    uint64
	TotalTimeMs  uint32
	HTTPStatus   uint16
	Requester    string
	RemoteIP     string
}

func (c *CH) InsertAccessLog(ctx context.Context, evs []AccessLogEvent) error {
	if len(evs) == 0 {
		return nil
	}
	batch, err := c.Conn.PrepareBatch(ctx, `INSERT INTO tiering.access_log`)
	if err != nil {
		return fmt.Errorf("prepare access_log batch: %w", err)
	}
	for _, e := range evs {
		if err := batch.Append(e.TS, e.Bucket, e.Collection, e.VolumeID, e.FileID, e.Path,
			e.Operation, e.ObjectSize, e.BytesSent, e.TotalTimeMs, e.HTTPStatus,
			e.Requester, e.RemoteIP); err != nil {
			return fmt.Errorf("append access_log: %w", err)
		}
	}
	if err := batch.Send(); err != nil {
		return fmt.Errorf("send access_log: %w", err)
	}
	return nil
}
