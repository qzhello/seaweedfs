package api

// AI budget alerts — surface and CRUD for ai_budgets, plus the
// evaluator endpoint that the dashboard polls and that opens
// alert_events when month-to-date spend crosses configured tiers.

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// listAIBudgets returns budgets with their live evaluation state
// (month-to-date spend, percent-of-cap, tier). The panel reads
// this on every refresh, so we avoid spawning alerts here — that
// happens in the explicit evaluate endpoint below.
func listAIBudgets(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		states, err := d.PG.EvaluateAIBudgets(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"rows": states})
	}
}

func upsertAIBudget(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body store.AIBudget
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		out, err := d.PG.UpsertAIBudget(c.Request.Context(), body)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, out)
	}
}

func deleteAIBudget(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
			return
		}
		if err := d.PG.DeleteAIBudget(c.Request.Context(), id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// evaluateAIBudgets runs the spend computation and fires
// alert_events for any budget that has newly crossed a threshold
// tier this calendar month. Dedup is enforced by
// ai_budget_alert_history's unique constraint so re-running this
// every minute is safe.
//
// Response includes the same state list listAIBudgets returns
// plus the slice of alerts that were actually fired this call,
// so the cron job (or the manual UI button) can confirm.
func evaluateAIBudgets(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		states, err := d.PG.EvaluateAIBudgets(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		fired := []gin.H{}
		for _, s := range states {
			if s.Tier == "ok" {
				continue
			}
			newly, err := d.PG.MarkBudgetAlertFired(c.Request.Context(), s.Budget.ID, s.Tier)
			if err != nil {
				// One alert failing to dedupe is not fatal — surface
				// the error in the response but keep evaluating the
				// rest so a flaky DB row doesn't block the others.
				fired = append(fired, gin.H{
					"budget_id": s.Budget.ID,
					"tier":      s.Tier,
					"error":     err.Error(),
				})
				continue
			}
			if !newly {
				continue
			}
			body := fmt.Sprintf(
				"AI spend on %s budget %q has reached %.1f%% of the %s%.2f monthly cap (%.2f spent so far this month).",
				s.Budget.ScopeType, s.Budget.Name, s.PercentOfCap,
				s.Budget.Currency, s.Budget.MonthlyLimit, s.MonthToDate)
			payload, _ := json.Marshal(s)
			id, err := d.PG.InsertAlertEvent(c.Request.Context(), store.AlertEvent{
				EventKind: "ai.budget." + s.Tier,
				Source:    fmt.Sprintf("budget:%s/%s", s.Budget.ScopeType, s.Budget.ScopeValue),
				Severity:  severityForTier(s.Tier),
				Title:     fmt.Sprintf("AI budget %s: %s", s.Tier, s.Budget.Name),
				Body:      body,
				Payload:   payload,
			})
			if err != nil {
				fired = append(fired, gin.H{
					"budget_id": s.Budget.ID,
					"tier":      s.Tier,
					"error":     err.Error(),
				})
				continue
			}
			fired = append(fired, gin.H{
				"budget_id": s.Budget.ID,
				"tier":      s.Tier,
				"alert_id":  id,
			})
		}
		c.JSON(http.StatusOK, gin.H{
			"states": states,
			"fired":  fired,
		})
	}
}

// severityForTier maps a budget tier to the alerter's severity
// vocabulary so existing alert routing rules (email / slack) can
// match on severity as usual.
func severityForTier(tier string) string {
	switch tier {
	case "critical":
		return "critical"
	case "warn":
		return "warning"
	default:
		return "info"
	}
}
