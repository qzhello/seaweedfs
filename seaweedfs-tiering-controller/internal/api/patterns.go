package api

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/analytics"
)

// volumePattern returns one volume's cyclical fingerprint + cohort z-score.
func volumePattern(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		idStr := c.Param("id")
		id, err := strconv.ParseUint(idStr, 10, 32)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad volume id"})
			return
		}
		p, err := d.CH.LatestPattern(c.Request.Context(), uint32(id))
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "no pattern snapshot yet"})
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"volume_id":         p.VolumeID,
			"business_domain":   p.BusinessDomain,
			"acf_24h":           p.ACF24h,
			"acf_168h":          p.ACF168h,
			"cycle_kind":        p.CycleKind,
			"reads_7d":          p.Reads7d,
			"reads_per_byte_7d": p.ReadsPerByte7d,
			"cohort_z_reads":    p.CohortZReads,
			"sparkline_168h":    p.Sparkline168h,
			"is_anomalous":      isAnomalousZ(p.CohortZReads),
			"thresholds": gin.H{
				"anomaly_z": analytics.AnomalyThreshold,
			},
		})
	}
}

// cohortBaselines returns one row per business_domain with mean/stddev/p50/p95.
func cohortBaselines(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		rows, err := d.CH.LatestCohortBaselines(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": rows})
	}
}

// cohortAnomalies returns volumes flagged with |z| >= threshold across all
// (or one) business domain. Used by the /cohort overview's outlier panel.
func cohortAnomalies(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		domain := c.Query("domain")
		thr := float32(analytics.AnomalyThreshold)
		limit := 100
		if v, err := strconv.Atoi(c.DefaultQuery("limit", "100")); err == nil && v > 0 {
			limit = v
		}
		if v, err := strconv.ParseFloat(c.Query("threshold"), 32); err == nil && v > 0 {
			thr = float32(v)
		}
		rows, err := d.CH.ListAnomalies(c.Request.Context(), domain, thr, limit)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": rows, "threshold": thr})
	}
}

// cohortBreakdown returns per-domain cycle-kind histograms.
func cohortBreakdown(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		rows, err := d.CH.CohortKindBreakdown(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": rows})
	}
}

// triggerAnalyticsPass runs one snapshot synchronously. Useful for the
// "refresh now" button after an operator changes business_domain tagging.
func triggerAnalyticsPass(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		if d.Analytics == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "analytics runner not configured"})
			return
		}
		if err := d.Analytics.OnePass(c.Request.Context()); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

func isAnomalousZ(z float32) bool {
	if z < 0 {
		z = -z
	}
	return float64(z) >= analytics.AnomalyThreshold
}
