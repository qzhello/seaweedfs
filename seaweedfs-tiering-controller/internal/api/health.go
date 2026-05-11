package api

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

func listMonitorTargets(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		ts, err := d.PG.ListMonitorTargets(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		states, _ := d.PG.ListHealthState(c.Request.Context())
		stateByID := map[uuid.UUID]store.HealthRow{}
		for _, s := range states {
			stateByID[s.TargetID] = s
		}
		out := make([]gin.H, 0, len(ts))
		for _, t := range ts {
			out = append(out, gin.H{"target": t, "health": stateByID[t.ID]})
		}
		c.JSON(http.StatusOK, gin.H{"items": out})
	}
}

func upsertMonitorTarget(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var t store.MonitorTarget
		if err := c.BindJSON(&t); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		id, err := d.PG.UpsertMonitorTarget(c.Request.Context(), t)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "upsert", "monitor_target", id.String(), t)
		c.JSON(http.StatusOK, gin.H{"id": id})
	}
}

func deleteMonitorTarget(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		if err := d.PG.DeleteMonitorTarget(c.Request.Context(), id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

func healthSamples(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		since := time.Now().Add(-2 * time.Hour)
		ss, err := d.PG.RecentHealthSamples(c.Request.Context(), id, since)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": ss, "since": since})
	}
}

// healthGate returns the scheduler-gating verdict, used by the dashboard
// banner and (more importantly) the scheduler itself.
func healthGate(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		ok, reason := d.Gate.Healthy()
		c.JSON(http.StatusOK, gin.H{
			"ok":     ok,
			"reason": reason,
			"gating": d.Gate.Snapshot(),
		})
	}
}
