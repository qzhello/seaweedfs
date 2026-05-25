package api

// AI token usage — middleware that attaches a request-scoped
// UsageRecorder to every Gin request, and an admin endpoint that
// rolls the captured events up for the dashboard.
//
// The recorder is invoked synchronously by the AI provider layer
// after each LLM call. Persistence happens in a detached goroutine
// using a background context so a slow database never blocks an
// in-flight chat response. The trade-off is that we may drop a
// usage row on a hard shutdown — acceptable for a metrics stream.

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/ai"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// aiUsageRecorderMiddleware attaches an ai.UsageRecorder onto every
// request's context. Handlers downstream can call any AI provider
// method and the resulting usage row will be persisted with the
// caller's user_id resolved from the principal — no per-handler
// wiring required.
func aiUsageRecorderMiddleware(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Best-effort user_id capture. Anonymous dev-mode requests
		// (auth disabled) get a nil user_id and still get recorded.
		var uidPtr *uuid.UUID
		if uid, ok := principalUserID(c); ok {
			uid := uid // capture for goroutine
			uidPtr = &uid
		}

		recorder := func(u ai.Usage) {
			ev := store.AIUsageEvent{
				OccurredAt:   u.OccurredAt,
				Provider:     u.Provider,
				Model:        u.Model,
				Operation:    u.Operation,
				InputTokens:  u.InputTokens,
				OutputTokens: u.OutputTokens,
				LatencyMS:    int(u.Latency / time.Millisecond),
				Err:          u.Err,
				UserID:       uidPtr,
			}
			// Detach: persistence must not extend the request's
			// critical path or fail it on DB hiccups.
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_ = d.PG.InsertAIUsage(ctx, ev)
			}()
		}
		c.Request = c.Request.WithContext(ai.WithUsageRecorder(c.Request.Context(), recorder))
		c.Next()
	}
}

// getAIUsage returns three rollups for the admin AI usage panel:
//   - by_day: time series for the stacked-bar chart
//   - by_model: provider×model totals across the window
//   - top_users: per-user activity for quota conversations
//
// `?days=` clamps to [1, 90]; default 7.
func getAIUsage(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		days := 7
		if q := c.Query("days"); q != "" {
			if n, err := strconv.Atoi(q); err == nil && n > 0 && n <= 90 {
				days = n
			}
		}

		byDay, err := d.PG.AIUsageDaily(c.Request.Context(), days)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		byModel, err := d.PG.AIUsageByModel(c.Request.Context(), days)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		topUsers, err := d.PG.AIUsageTopUsers(c.Request.Context(), days, 10)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"days":      days,
			"by_day":    byDay,
			"by_model":  byModel,
			"top_users": topUsers,
		})
	}
}
