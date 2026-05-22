package api

// Capacity forecast — the proactive complement to capacity_incidents.
// For each cluster we fit a least-squares line to its daily used-bytes
// history (from node_usage_snapshot) and project when usage crosses the
// capacity ceiling: "full in ~N days".
//
//	GET /capacity/forecast  — one forecast per enabled cluster
//
// Note on the ceiling: node_usage_snapshot.capacity is the volume-slot
// capacity (max_volume_count × volume size) — which IS the wall the
// cluster actually hits, so projecting used → capacity is sound.

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// forecastWindow is how much history the projection fits over. Long
// enough to smooth daily noise, short enough to track a recent trend
// change rather than averaging it away.
const forecastWindow = 30 * 24 * time.Hour

// forecastMaxDays caps the projection horizon — beyond this a cluster is
// "ample runway" and a precise date is meaningless (and would risk
// overflowing time.Duration).
const forecastMaxDays = 3650.0

type capacityForecast struct {
	ClusterID         string     `json:"cluster_id"`
	ClusterName       string     `json:"cluster_name"`
	UsedBytes         int64      `json:"used_bytes"`
	CapacityBytes     int64      `json:"capacity_bytes"`
	PercentFull       float64    `json:"percent_full"`
	GrowthBytesPerDay float64    `json:"growth_bytes_per_day"`
	DaysToFull        *float64   `json:"days_to_full,omitempty"`
	ProjectedFullAt   *time.Time `json:"projected_full_at,omitempty"`
	Confidence        string     `json:"confidence"` // none | low | medium | high
	Status            string     `json:"status"`     // no_data | stable | ok | warning | critical
	SampleDays        int        `json:"sample_days"`
	Note              string     `json:"note"`
}

func capacityForecastAll(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		items, err := computeCapacityForecasts(c.Request.Context(), d)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": items})
	}
}

// computeCapacityForecasts builds one forecast per enabled cluster.
// Shared by the /capacity/forecast endpoint and the assistant's
// get_capacity_forecast tool.
func computeCapacityForecasts(ctx context.Context, d Deps) ([]capacityForecast, error) {
	clusters, err := d.PG.ListClusters(ctx)
	if err != nil {
		return nil, err
	}
	since := time.Now().Add(-forecastWindow)
	items := make([]capacityForecast, 0, len(clusters))
	for _, cl := range clusters {
		if !cl.Enabled {
			continue
		}
		hist, herr := d.PG.ClusterCapacityHistory(ctx, cl.ID, since)
		if herr != nil {
			// One bad cluster must not blank the whole forecast.
			items = append(items, capacityForecast{
				ClusterID: cl.ID.String(), ClusterName: cl.Name,
				Status: "no_data", Confidence: "none",
				Note: "capacity history unavailable",
			})
			continue
		}
		items = append(items, forecastFromHistory(cl.ID.String(), cl.Name, hist))
	}
	return items, nil
}

// forecastFromHistory fits a least-squares line to the daily used-bytes
// series and projects when it crosses the capacity ceiling.
func forecastFromHistory(clusterID, clusterName string, hist []store.ClusterUsagePoint) capacityForecast {
	f := capacityForecast{
		ClusterID: clusterID, ClusterName: clusterName,
		Confidence: "none", Status: "no_data", SampleDays: len(hist),
	}
	if len(hist) == 0 {
		f.Note = "no capacity snapshots yet"
		return f
	}
	last := hist[len(hist)-1]
	f.UsedBytes = last.Used
	f.CapacityBytes = last.Capacity
	if last.Capacity > 0 {
		f.PercentFull = float64(last.Used) / float64(last.Capacity) * 100
	}
	if len(hist) < 3 {
		f.Note = "need a few more days of history to forecast"
		return f
	}

	// Least-squares fit: x = days since the first sample, y = used bytes.
	t0 := hist[0].Day
	n := float64(len(hist))
	xs := make([]float64, len(hist))
	ys := make([]float64, len(hist))
	var sx, sy, sxx, sxy float64
	for i, p := range hist {
		x := p.Day.Sub(t0).Hours() / 24
		y := float64(p.Used)
		xs[i], ys[i] = x, y
		sx += x
		sy += y
		sxx += x * x
		sxy += x * y
	}
	denom := n*sxx - sx*sx
	if denom == 0 {
		f.Status = "stable"
		f.Note = "samples span too little time to forecast"
		return f
	}
	slope := (n*sxy - sx*sy) / denom // bytes/day
	intercept := (sy - slope*sx) / n
	f.GrowthBytesPerDay = slope

	// R² → coarse confidence in the linear fit.
	meanY := sy / n
	var ssRes, ssTot float64
	for i := range xs {
		pred := intercept + slope*xs[i]
		ssRes += (ys[i] - pred) * (ys[i] - pred)
		ssTot += (ys[i] - meanY) * (ys[i] - meanY)
	}
	r2 := 1.0
	if ssTot > 0 {
		r2 = 1 - ssRes/ssTot
	}
	switch {
	case r2 >= 0.85:
		f.Confidence = "high"
	case r2 >= 0.5:
		f.Confidence = "medium"
	default:
		f.Confidence = "low"
	}

	if slope <= 0 {
		f.Status = "stable"
		f.Note = "usage flat or shrinking — no exhaustion projected"
		return f
	}
	headroom := float64(last.Capacity - last.Used)
	if headroom <= 0 {
		zero := 0.0
		f.DaysToFull = &zero
		f.Status = "critical"
		f.Note = "already at capacity"
		return f
	}
	days := headroom / slope
	f.DaysToFull = &days
	if days <= forecastMaxDays {
		full := time.Now().Add(time.Duration(days * 24 * float64(time.Hour)))
		f.ProjectedFullAt = &full
	}
	switch {
	case days < 14:
		f.Status = "critical"
	case days < 60:
		f.Status = "warning"
	default:
		f.Status = "ok"
	}
	f.Note = "projected at the current 30-day growth rate"
	return f
}
