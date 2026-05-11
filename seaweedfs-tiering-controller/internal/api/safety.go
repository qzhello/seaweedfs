package api

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

func listBlocklist(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		bs, err := d.PG.ListBlocklist(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": bs})
	}
}

func upsertBlocklist(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var b store.Blocklist
		if err := c.BindJSON(&b); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		b.CreatedBy = userOf(c)
		id, err := d.PG.UpsertBlocklist(c.Request.Context(), b)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "upsert", "blocklist", id.String(), b)
		c.JSON(http.StatusOK, gin.H{"id": id})
	}
}

func deleteBlocklist(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		if err := d.PG.DeleteBlocklist(c.Request.Context(), id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

func listMaintenance(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		includePast := c.Query("include_past") == "true"
		ms, err := d.PG.ListMaintenanceWindows(c.Request.Context(), includePast)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": ms})
	}
}

func upsertMaintenance(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var m store.MaintenanceWindow
		if err := c.BindJSON(&m); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		m.CreatedBy = userOf(c)
		id, err := d.PG.UpsertMaintenanceWindow(c.Request.Context(), m)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "upsert", "maintenance", id.String(), m)
		c.JSON(http.StatusOK, gin.H{"id": id})
	}
}

func deleteMaintenance(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		if err := d.PG.DeleteMaintenanceWindow(c.Request.Context(), id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// safetyStatus is the Dashboard banner aggregator: returns the overall verdict
// at /api/v1/safety/status so the Web UI can show one banner with the right
// reason without making 4 separate calls.
func safetyStatus(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		v := d.Guard.Allow(c.Request.Context(), nil, time.Now())
		gateOK, gateReason := true, ""
		if d.Gate != nil {
			gateOK, gateReason = d.Gate.Healthy()
		}
		c.JSON(http.StatusOK, gin.H{
			"safety_allowed":  v.Allowed,
			"safety_reason":   v.Reason,
			"safety_code":     v.Code,
			"health_gate_ok":  gateOK,
			"health_reason":   gateReason,
			"overall_allowed": v.Allowed && gateOK,
		})
	}
}

// emergencyStop is a convenience wrapper around system_config so the
// dashboard can wire a big red button to a single endpoint instead of
// requiring the user to navigate to /settings.
func emergencyStop(d Deps) gin.HandlerFunc {
	type req struct {
		Engaged bool   `json:"engaged"`
		Note    string `json:"note"`
	}
	return func(c *gin.Context) {
		var r req
		if err := c.BindJSON(&r); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		val := []byte("false")
		if r.Engaged {
			val = []byte("true")
		}
		// Look up version for OCC.
		cur, err := d.PG.GetConfig(c.Request.Context(), "safety.emergency_stop")
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if err := d.PG.SetConfig(c.Request.Context(), "safety.emergency_stop",
			val, cur.Version, userOf(c)); err != nil {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "emergency_stop", "safety", "global",
			gin.H{"engaged": r.Engaged, "note": r.Note})
		// High-severity alert for posterity.
		d.Alerts.Emit(alerterEvent("safety.emergency_stop", "global",
			boolToSeverity(r.Engaged),
			"Emergency stop "+boolToVerb(r.Engaged),
			"Engaged="+boolToString(r.Engaged)+", note="+r.Note+", actor="+userOf(c)))
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}
