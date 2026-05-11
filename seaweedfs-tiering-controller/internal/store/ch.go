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
		FROM tiering.volume_features FINAL
		WHERE volume_id = ?`, volumeID)
	var f VolumeFeatures
	var ro uint8
	if err := row.Scan(&f.VolumeID, &f.Collection, &f.SizeBytes, &ro, &f.QuietForSeconds,
		&f.LastAccessSecs, &f.Reads7d, &f.Reads30d, &f.Writes30d, &f.UniqueKeys30d); err != nil {
		return nil, fmt.Errorf("scan features: %w", err)
	}
	f.IsReadonly = ro == 1
	return &f, nil
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
