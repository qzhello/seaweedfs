package api

// Temperature endpoints — surface ClickHouse-derived hot/warm/cool/cold/
// frozen classification per collection and per volume. The Temperature
// dashboard uses this to flag which collections have cooled down and
// to feed tiering policy drafting.

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

// temperatureCollections returns the per-collection breakdown plus a
// rolled-up grand total so the UI can render headline tiles without a
// second roundtrip.
func temperatureCollections(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		rows, err := d.CH.CollectionTemperatures(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		// Aggregate totals client-side once instead of running a
		// second GROUP BY () — the result set is bounded by the
		// number of collections (typically dozens, never millions).
		var total struct {
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
		for _, r := range rows {
			total.Volumes += r.Volumes
			total.TotalSize += r.TotalSize
			total.Reads7d += r.Reads7d
			total.Reads30d += r.Reads30d
			total.HotN += r.HotN
			total.HotSize += r.HotSize
			total.WarmN += r.WarmN
			total.WarmSize += r.WarmSize
			total.CoolN += r.CoolN
			total.CoolSize += r.CoolSize
			total.ColdN += r.ColdN
			total.ColdSize += r.ColdSize
			total.FrozenN += r.FrozenN
			total.FrozenSize += r.FrozenSize
		}
		c.JSON(http.StatusOK, gin.H{
			"items": rows,
			"total": total,
			"thresholds": gin.H{
				"hot_reads_7d":      50,
				"hot_quiet_seconds": 3600,
				"frozen_seconds":    90 * 86400,
			},
		})
	}
}

// temperatureVolumes returns the per-volume drilldown. `collection`
// query param scopes the result; omitting it returns the top `limit`
// volumes by size across all collections.
func temperatureVolumes(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		coll := c.Query("collection")
		limit := 5000
		if s := c.Query("limit"); s != "" {
			if n, err := strconv.Atoi(s); err == nil && n > 0 && n <= 50000 {
				limit = n
			}
		}
		rows, err := d.CH.VolumeTemperatures(c.Request.Context(), coll, limit)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": rows, "collection": coll, "limit": limit})
	}
}
