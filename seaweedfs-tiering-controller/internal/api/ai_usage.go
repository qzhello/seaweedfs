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
		pricing, err := d.PG.ListAIModelPricing(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		costIdx := buildPricingIndex(pricing)
		currency := dominantCurrency(pricing)

		// Decorate rollups with estimated cost in-place. Models we
		// have no pricing for contribute 0; the panel flags them as
		// "unpriced" rather than silently underreporting spend.
		byDayCost := make([]usageDailyWithCost, len(byDay))
		var totalCost float64
		for i, r := range byDay {
			// Shadows the outer gin.Context `c` deliberately inside this
			// short scope — `cost` would be clearer but every other row
			// in this file uses `cost` for the per-model total, so we
			// keep this one terse.
			rowCost := computeCost(costIdx, r.Provider, r.Model, r.InputTokens, r.OutputTokens)
			byDayCost[i] = usageDailyWithCost{AIUsageDailyRow: r, EstimatedCost: rowCost}
		}
		byModelCost := make([]usageModelWithCost, len(byModel))
		unpriced := 0
		for i, r := range byModel {
			cost := computeCost(costIdx, r.Provider, r.Model, r.InputTokens, r.OutputTokens)
			byModelCost[i] = usageModelWithCost{
				AIUsageModelTotal: r,
				EstimatedCost:     cost,
				Priced:            costIdx.has(r.Provider, r.Model),
			}
			if !costIdx.has(r.Provider, r.Model) && (r.InputTokens > 0 || r.OutputTokens > 0) {
				unpriced++
			}
			totalCost += cost
		}
		topUsersCost := make([]usageTopUserWithCost, len(topUsers))
		// Top-user cost requires re-attributing tokens to models; we
		// don't have that breakdown in the simple top-users query.
		// Approximate by applying the *fleet-average* cost per token
		// computed from byModel — usable for "biggest spender" sort
		// without misleading rounding.
		var fleetIn, fleetOut int64
		for _, r := range byModel {
			fleetIn += r.InputTokens
			fleetOut += r.OutputTokens
		}
		var avgIn, avgOut float64
		if fleetIn > 0 {
			avgIn = totalCost * (float64(fleetIn) / float64(fleetIn+fleetOut)) / float64(fleetIn)
		}
		if fleetOut > 0 {
			avgOut = totalCost * (float64(fleetOut) / float64(fleetIn+fleetOut)) / float64(fleetOut)
		}
		for i, r := range topUsers {
			topUsersCost[i] = usageTopUserWithCost{
				AIUsageTopUser: r,
				EstimatedCost:  avgIn*float64(r.InputTokens) + avgOut*float64(r.OutputTokens),
			}
		}

		c.JSON(http.StatusOK, gin.H{
			"days":              days,
			"currency":          currency,
			"by_day":            byDayCost,
			"by_model":          byModelCost,
			"top_users":         topUsersCost,
			"total_cost":        totalCost,
			"unpriced_models":   unpriced,
			"pricing_row_count": len(pricing),
		})
	}
}

// pricingIndex is a small lookup keyed by "provider/model". Built
// once per request because the table is tiny enough that re-fetching
// per row would be silly, but persistent caching would over-engineer
// what is essentially a config join.
type pricingIndex struct {
	rows map[string]store.AIModelPricing
}

func buildPricingIndex(rows []store.AIModelPricing) pricingIndex {
	m := make(map[string]store.AIModelPricing, len(rows))
	for _, r := range rows {
		m[r.Provider+"/"+r.Model] = r
	}
	return pricingIndex{rows: m}
}

func (p pricingIndex) has(provider, model string) bool {
	_, ok := p.rows[provider+"/"+model]
	return ok
}

// computeCost prices a (provider, model) pair against the loaded
// pricing rows. Returns 0 for unknown models — callers that want
// to distinguish "free" from "unknown" should use has().
func computeCost(idx pricingIndex, provider, model string, inTok, outTok int64) float64 {
	r, ok := idx.rows[provider+"/"+model]
	if !ok {
		return 0
	}
	const tokPerMil = 1_000_000.0
	return r.InputPricePer1MTok*(float64(inTok)/tokPerMil) +
		r.OutputPricePer1MTok*(float64(outTok)/tokPerMil)
}

// dominantCurrency picks the currency to show on the dashboard
// summary tile when pricing rows disagree (which they shouldn't,
// but the schema allows). Returns "USD" on an empty table.
func dominantCurrency(rows []store.AIModelPricing) string {
	counts := map[string]int{}
	for _, r := range rows {
		counts[r.Currency]++
	}
	best := "USD"
	bestN := 0
	for k, n := range counts {
		if n > bestN {
			best = k
			bestN = n
		}
	}
	return best
}

// usage*WithCost are decorated copies of the store types. We keep
// the store rows pristine so other callers (analytics jobs) aren't
// forced to consume the cost-enriched shape.
type usageDailyWithCost struct {
	store.AIUsageDailyRow
	EstimatedCost float64 `json:"estimated_cost"`
}
type usageModelWithCost struct {
	store.AIUsageModelTotal
	EstimatedCost float64 `json:"estimated_cost"`
	Priced        bool    `json:"priced"`
}
type usageTopUserWithCost struct {
	store.AIUsageTopUser
	EstimatedCost float64 `json:"estimated_cost"`
}

// ---- Pricing CRUD ----

// listAIModelPricing returns every priced model. Read-allowed for
// any logged-in operator so the AI Usage panel can decorate
// without needing admin caps; mutating handlers below are admin-only.
func listAIModelPricing(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		rows, err := d.PG.ListAIModelPricing(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"rows": rows})
	}
}

func upsertAIModelPricing(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body store.AIModelPricing
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		// Sanity floor: a model with a negative price almost
		// certainly means a transcription error in the editor.
		if body.InputPricePer1MTok < 0 || body.OutputPricePer1MTok < 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "prices must be >= 0"})
			return
		}
		if err := d.PG.UpsertAIModelPricing(c.Request.Context(), body); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

func deleteAIModelPricing(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		provider := c.Query("provider")
		model := c.Query("model")
		if provider == "" || model == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "provider and model query params required"})
			return
		}
		if err := d.PG.DeleteAIModelPricing(c.Request.Context(), provider, model); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}
