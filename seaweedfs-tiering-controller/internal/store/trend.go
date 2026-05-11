package store

import (
	"context"
	"fmt"
	"time"
)

// TrendPoint is one bucket on the time-series axis.
type TrendPoint struct {
	Bucket    time.Time `json:"bucket"`
	Reads     uint64    `json:"reads"`
	Writes    uint64    `json:"writes"`
	BytesRead uint64    `json:"bytes_read"`
}

// TrendOpts configures the trend query window and resolution.
type TrendOpts struct {
	Since      time.Time
	Until      time.Time
	Resolution string // "hour" | "day" | "week"
	Collection string // optional filter (matches access_log.collection)
}

// Trend returns aggregated read/write metrics over the requested window.
// Powered by tiering.volume_stats_hourly so the query is fast even over months.
func (c *CH) Trend(ctx context.Context, o TrendOpts) ([]TrendPoint, error) {
	bucketExpr := "toStartOfHour(hour)"
	switch o.Resolution {
	case "day":
		bucketExpr = "toStartOfDay(hour)"
	case "week":
		bucketExpr = "toStartOfWeek(hour)"
	}
	q := fmt.Sprintf(`
		SELECT %s AS bucket,
		       sum(reads) AS reads,
		       sum(writes) AS writes,
		       sum(bytes_read) AS bytes_read
		FROM tiering.volume_stats_hourly
		WHERE hour BETWEEN ? AND ?
		  %s
		GROUP BY bucket ORDER BY bucket`, bucketExpr, collectionFilter(o.Collection))

	args := []any{o.Since, o.Until}
	if o.Collection != "" {
		args = append(args, o.Collection)
	}
	rows, err := c.Conn.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("trend query: %w", err)
	}
	defer rows.Close()
	out := []TrendPoint{}
	for rows.Next() {
		var p TrendPoint
		if err := rows.Scan(&p.Bucket, &p.Reads, &p.Writes, &p.BytesRead); err != nil {
			return nil, fmt.Errorf("scan trend: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// TrendByDomain aggregates over collections, joining a static collection→domain
// map (passed by the API layer from PG resource_tags). Returns one series per domain.
type DomainTrend struct {
	Domain string       `json:"domain"`
	Points []TrendPoint `json:"points"`
}

func (c *CH) TrendByCollections(ctx context.Context, since, until time.Time,
	resolution string, byCollection map[string]string) ([]DomainTrend, error) {

	if len(byCollection) == 0 {
		return []DomainTrend{}, nil
	}
	bucketExpr := "toStartOfHour(hour)"
	switch resolution {
	case "day":
		bucketExpr = "toStartOfDay(hour)"
	case "week":
		bucketExpr = "toStartOfWeek(hour)"
	}
	colls := make([]any, 0, len(byCollection))
	for k := range byCollection {
		colls = append(colls, k)
	}
	q := fmt.Sprintf(`
		SELECT %s AS bucket, collection,
		       sum(reads) AS reads,
		       sum(writes) AS writes,
		       sum(bytes_read) AS bytes_read
		FROM tiering.volume_stats_hourly
		WHERE hour BETWEEN ? AND ?
		  AND collection IN (%s)
		GROUP BY bucket, collection ORDER BY collection, bucket`,
		bucketExpr, placeholders(len(colls)))
	args := append([]any{since, until}, colls...)
	rows, err := c.Conn.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("trend by collection: %w", err)
	}
	defer rows.Close()
	domains := map[string][]TrendPoint{}
	for rows.Next() {
		var b time.Time
		var coll string
		var r, w, br uint64
		if err := rows.Scan(&b, &coll, &r, &w, &br); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		d := byCollection[coll]
		if d == "" {
			d = "other"
		}
		domains[d] = append(domains[d], TrendPoint{Bucket: b, Reads: r, Writes: w, BytesRead: br})
	}
	out := []DomainTrend{}
	for d, pts := range domains {
		out = append(out, DomainTrend{Domain: d, Points: pts})
	}
	return out, rows.Err()
}

func collectionFilter(coll string) string {
	if coll == "" {
		return ""
	}
	return "AND collection = ?"
}

func placeholders(n int) string {
	out := ""
	for i := 0; i < n; i++ {
		if i > 0 {
			out += ","
		}
		out += "?"
	}
	return out
}
