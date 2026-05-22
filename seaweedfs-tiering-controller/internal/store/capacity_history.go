package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// ClusterUsagePoint is one daily-downsampled point of a cluster's capacity
// history — the input series for the capacity forecast's linear projection.
type ClusterUsagePoint struct {
	Day      time.Time `json:"day"`
	Used     int64     `json:"used"`
	Capacity int64     `json:"capacity"`
}

// ClusterCapacityHistory returns daily (used, capacity) totals for a
// cluster since `since`, oldest first.
//
// Every node_usage_snapshot pass shares one snapshot_at across all disks,
// so the inner query first SUMs disks into a per-instant cluster total;
// the outer query then averages those instants into one row per day
// (~5-minute snapshots would otherwise be thousands of points).
func (p *PG) ClusterCapacityHistory(ctx context.Context, clusterID uuid.UUID, since time.Time) ([]ClusterUsagePoint, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT date_trunc('day', s.snapshot_at) AS day,
		       avg(s.used)::bigint              AS used,
		       avg(s.capacity)::bigint          AS capacity
		FROM (
		    SELECT snapshot_at,
		           SUM(used)     AS used,
		           SUM(capacity) AS capacity
		    FROM node_usage_snapshot
		    WHERE cluster_id = $1 AND snapshot_at >= $2
		    GROUP BY snapshot_at
		) s
		GROUP BY day
		ORDER BY day`, clusterID, since)
	if err != nil {
		return nil, fmt.Errorf("cluster capacity history: %w", err)
	}
	defer rows.Close()
	out := []ClusterUsagePoint{}
	for rows.Next() {
		var pt ClusterUsagePoint
		if err := rows.Scan(&pt.Day, &pt.Used, &pt.Capacity); err != nil {
			return nil, fmt.Errorf("scan capacity point: %w", err)
		}
		out = append(out, pt)
	}
	return out, rows.Err()
}
