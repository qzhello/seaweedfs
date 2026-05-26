package api

import (
	"fmt"
	"net/http"
	"strconv"
	"time"

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
		// include_ack=1 brings acknowledged (dismissed) events back into
		// the list for the alerts page "show ignored" toggle. Default
		// is to hide them so Today's Attention stays quiet.
		includeAck := c.Query("include_ack") == "1" || c.Query("include_ack") == "true"
		es, err := d.PG.RecentAlertEvents(c.Request.Context(), limit, includeAck)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": es})
	}
}

// ackAlertEvents marks the given event IDs (or everything older than a
// cutoff) as acknowledged. Body: { ids?: int64[], before?: RFC3339 }.
// "ids" takes precedence; "before" is the "ignore-all-currently-shown"
// path from Today's Attention.
func ackAlertEvents(d Deps) gin.HandlerFunc {
	type req struct {
		IDs    []int64 `json:"ids"`
		Before string  `json:"before"`
	}
	return func(c *gin.Context) {
		var r req
		if err := c.BindJSON(&r); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		user := userOf(c)
		var n int64
		var err error
		switch {
		case len(r.IDs) > 0:
			n, err = d.PG.AckAlertEvents(c.Request.Context(), r.IDs, user)
		case r.Before != "":
			t, perr := time.Parse(time.RFC3339, r.Before)
			if perr != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "bad 'before' timestamp: " + perr.Error()})
				return
			}
			n, err = d.PG.AckAllUnackBefore(c.Request.Context(), t, user)
		default:
			c.JSON(http.StatusBadRequest, gin.H{"error": "provide 'ids' or 'before'"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), user, "ack", "alert_events", "",
			fmt.Sprintf("acked=%d ids=%d before=%s", n, len(r.IDs), r.Before))
		c.JSON(http.StatusOK, gin.H{"acked": n})
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
