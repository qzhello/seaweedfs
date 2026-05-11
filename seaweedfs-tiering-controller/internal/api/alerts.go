package api

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/alerter"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

func listAlertChannels(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		cs, err := d.PG.ListAlertChannels(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": cs})
	}
}

func upsertAlertChannel(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var x store.AlertChannel
		if err := c.BindJSON(&x); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		id, err := d.PG.UpsertAlertChannel(c.Request.Context(), x)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "upsert", "alert_channel", id.String(), x.Name)
		c.JSON(http.StatusOK, gin.H{"id": id})
	}
}

func deleteAlertChannel(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		if err := d.PG.DeleteAlertChannel(c.Request.Context(), id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

func listAlertRules(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		rs, err := d.PG.ListAlertRules(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": rs})
	}
}

func upsertAlertRule(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var x store.AlertRule
		if err := c.BindJSON(&x); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		id, err := d.PG.UpsertAlertRule(c.Request.Context(), x)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "upsert", "alert_rule", id.String(), x.Name)
		c.JSON(http.StatusOK, gin.H{"id": id})
	}
}

func deleteAlertRule(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		if err := d.PG.DeleteAlertRule(c.Request.Context(), id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

func recentAlertEvents(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		limit, _ := strconv.Atoi(c.DefaultQuery("limit", "100"))
		es, err := d.PG.RecentAlertEvents(c.Request.Context(), limit)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": es})
	}
}

// fireTestAlert lets admins verify a channel without waiting for a real
// degradation event.
func fireTestAlert(d Deps) gin.HandlerFunc {
	type req struct {
		Source   string `json:"source"`
		Severity string `json:"severity"`
		Title    string `json:"title"`
		Body     string `json:"body"`
	}
	return func(c *gin.Context) {
		var r req
		if err := c.BindJSON(&r); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if r.Source == "" {
			r.Source = "manual_test"
		}
		if r.Severity == "" {
			r.Severity = "warning"
		}
		if r.Title == "" {
			r.Title = "Test alert"
		}
		d.Alerts.Emit(alerter.Event{
			Kind: "manual.test", Source: r.Source, Severity: r.Severity,
			Title: r.Title, Body: r.Body,
		})
		c.JSON(http.StatusOK, gin.H{"queued": true})
	}
}
