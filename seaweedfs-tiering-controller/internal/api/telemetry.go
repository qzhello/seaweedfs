package api

// Gateway telemetry endpoints. Read-only — the gateway writes directly
// into ClickHouse (`tiering.gateway_events`). These handlers surface
// aggregates the Costs dashboard + AI planner consume.

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

func telemetryByBucket(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		limit := 100
		if s := c.Query("limit"); s != "" {
			if n, err := strconv.Atoi(s); err == nil && n > 0 && n <= 1000 {
				limit = n
			}
		}
		rows, err := d.CH.BucketAccessSummary(c.Request.Context(), limit)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": rows})
	}
}

// telemetryAccessSummary is a convenience flag-rollup the dashboard
// uses for headline numbers ("X requests last 30d, Y TB read"). It's
// essentially the per-bucket summary collapsed to a single row.
func telemetryAccessSummary(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		rows, err := d.CH.BucketAccessSummary(c.Request.Context(), 1000)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		var totalReqs, totalReads, totalWrites, totalBytesOut, totalBytesIn uint64
		buckets := 0
		for _, r := range rows {
			totalReqs += r.Requests30d
			totalReads += r.Reads30d
			totalWrites += r.Writes30d
			totalBytesOut += r.BytesOut30d
			totalBytesIn += r.BytesIn30d
			buckets++
		}
		c.JSON(http.StatusOK, gin.H{
			"buckets":         buckets,
			"requests_30d":    totalReqs,
			"reads_30d":       totalReads,
			"writes_30d":      totalWrites,
			"bytes_out_30d":   totalBytesOut,
			"bytes_in_30d":    totalBytesIn,
		})
	}
}
