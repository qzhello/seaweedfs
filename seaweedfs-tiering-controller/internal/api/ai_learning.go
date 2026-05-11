package api

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

// learningSummary returns accuracy aggregations for the dashboard. The
// observation horizon is a query param (default 24h) so operators can
// compare short-window vs long-window judgment.
func learningSummary(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		hours := 24
		if v, err := strconv.Atoi(c.DefaultQuery("hours", "24")); err == nil && v > 0 {
			hours = v
		}
		ctx := c.Request.Context()
		byProv, err := d.PG.AccuracyByProvider(ctx, hours)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		byDom, err := d.PG.AccuracyByDomain(ctx, hours)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		recent, err := d.PG.RecentOutcomes(ctx, 100)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"hours":          hours,
			"by_provider":    byProv,
			"by_domain":      byDom,
			"recent_outcomes": recent,
		})
	}
}
