package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// GET /counts returns small counters the UI polls every few seconds
// to paint live badges on nav items. Kept intentionally lightweight:
// each value is a single SQL COUNT, never a list scan. The handler
// degrades gracefully — any sub-count that fails returns 0 so a
// transient DB hiccup doesn't blank the whole nav.
func counts(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx := c.Request.Context()
		out := gin.H{
			"pending_tasks":      0,
			"running_tasks":      0,
			"running_executions": 0,
			"running_ops_runs":   0,
		}
		if n, err := d.PG.CountTasksByStatus(ctx, "pending"); err == nil {
			out["pending_tasks"] = n
		}
		if n, err := d.PG.CountTasksByStatus(ctx, "running"); err == nil {
			out["running_tasks"] = n
		}
		if n, err := d.PG.CountExecutionsByStatus(ctx, "running"); err == nil {
			out["running_executions"] = n
		}
		// Ops runs live in-memory only (SSE-attached). The registry
		// can answer the question without touching the DB.
		if d.OpsRuns != nil {
			out["running_ops_runs"] = d.OpsRuns.activeCount()
		}
		c.JSON(http.StatusOK, out)
	}
}
