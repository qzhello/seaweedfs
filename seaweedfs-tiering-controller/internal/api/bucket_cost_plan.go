package api

// AI bucket-level cost planner. Complements the existing
// collection-level /costs/ai-plan (cost_ai_plan.go) by reasoning at the
// bucket layer where lifecycle controls (quota, multipart cleanup,
// deletion) actually live.
//
// Why a separate endpoint rather than extending cost_ai_plan.go:
//   - Action set differs. cost_ai_plan emits `volume.tier.move`
//     proposals against collections; this emits bucket-shaped actions
//     (set_quota, cleanup_uploads, review_for_deletion,
//     investigate_tiering) that the operator can apply with one click
//     using existing /s3/bucket/* endpoints.
//   - Signal differs. The dominant input is bucket telemetry (last
//     access, R/W ratio) and current quota/usage — not collection
//     bytes by backend.
//   - Each proposal is persisted independently so the AI Learning
//     panel can aggregate accept/discard per action, which is the
//     metric that tells us if e.g. "review_for_deletion" is calibrated.
//
// Caveats (surfaced in the prompt):
//   - SeaweedFS doesn't expose per-bucket dollar cost. The AI
//     estimates savings from current quota / bytes-stored + the
//     hot-tier price, marked as approximate.
//   - investigate_tiering proposals are advisory — no one-click apply
//     because volumes-under-buckets need operator-driven mapping.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

const (
	bucketCostPlanMaxProposals = 10
	bucketCostPlanTopBuckets   = 30 // how many buckets we feed to the prompt
)

// bucketCostProposal is one item the AI returns.
type bucketCostProposal struct {
	Bucket           string          `json:"bucket"`
	Action           string          `json:"action"` // set_quota | cleanup_uploads | review_for_deletion | investigate_tiering
	Value            json.RawMessage `json:"value"`  // action-specific payload (e.g. {"quota_mb": 50000})
	Risk             string          `json:"risk"`   // low | medium | high
	Confidence       string          `json:"confidence"`
	Explanation      string          `json:"explanation"`
	EstMonthlySaving float64         `json:"est_monthly_saving"`
}

// bucketCostPlan handles POST /api/v1/clusters/:id/buckets/cost-plan
// Body: { extra_context?: string, max_proposals?: int }
func bucketCostPlan(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		var body struct {
			ExtraContext string `json:"extra_context"`
			MaxProposals int    `json:"max_proposals"`
		}
		_ = c.ShouldBindJSON(&body)
		if body.MaxProposals <= 0 || body.MaxProposals > bucketCostPlanMaxProposals {
			body.MaxProposals = 5
		}

		cl, err := d.PG.GetCluster(c.Request.Context(), clusterID)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), 90*time.Second)
		defer cancel()

		// Telemetry first — if ClickHouse hasn't received gateway events
		// yet there's nothing to reason about.
		buckets, _ := d.CH.BucketAccessSummary(ctx, bucketCostPlanTopBuckets)
		if len(buckets) == 0 {
			c.JSON(http.StatusOK, gin.H{
				"ok":      true,
				"empty":   true,
				"message": "No gateway telemetry available for any bucket; planner needs at least one bucket with recent traffic to reason about.",
			})
			return
		}

		// Cost frame — we feed the AI hot-tier price/TB so it can
		// estimate dollar savings rather than guessing.
		// computeCosts gives us currency + the hot reference backend
		// name; we walk Backends to find that row's per-TB price so the
		// AI can ground saving estimates in a real number.
		costs, costErr := computeCosts(ctx, d, clusterID)
		var hotPriceTBMonth float64
		var currency = "USD"
		if costErr == nil && costs != nil {
			if costs.Currency != "" {
				currency = costs.Currency
			}
			for _, bb := range costs.Backends {
				if bb.Name == costs.HotReferenceBackend {
					hotPriceTBMonth = bb.PricePerTBMonth
					break
				}
			}
		}

		provider, perr := resolveAssistantProvider(ctx, d)
		if perr != nil {
			c.JSON(http.StatusOK, gin.H{"ok": false, "error": "AI provider not configured: " + perr.Error()})
			return
		}
		chatter, ok := provider.(jsonChatter)
		if !ok {
			c.JSON(http.StatusOK, gin.H{"ok": false, "error": "Configured AI provider does not support JSON chat."})
			return
		}

		prompt := buildBucketCostPrompt(cl.Name, buckets, hotPriceTBMonth, currency, body.ExtraContext, body.MaxProposals)
		raw, aerr := chatter.JSONChat(ctx, prompt)
		if aerr != nil {
			c.JSON(http.StatusOK, gin.H{"ok": false, "error": "AI call failed: " + aerr.Error()})
			return
		}

		var parsed struct {
			Summary   string               `json:"summary"`
			Proposals []bucketCostProposal `json:"proposals"`
		}
		if err := json.Unmarshal([]byte(extractJSONObject(raw)), &parsed); err != nil {
			c.JSON(http.StatusOK, gin.H{
				"ok":    false,
				"error": "AI did not return a parseable plan.",
				"raw":   raw,
			})
			return
		}

		validProposals, warnings := validateBucketCostProposals(parsed.Proposals, buckets)
		sort.Slice(validProposals, func(i, j int) bool {
			return validProposals[i].EstMonthlySaving > validProposals[j].EstMonthlySaving
		})

		// Persist each proposal so the operator's eventual approve/discard
		// becomes counterfactual signal. Failure to log doesn't fail the
		// response — degraded learning is better than no plan.
		snapshot, _ := json.Marshal(map[string]any{
			"buckets":        buckets,
			"hot_tier_price": hotPriceTBMonth,
			"currency":       currency,
			"current_time":   time.Now().UTC().Format(time.RFC3339),
		})
		pp, _ := auth.Of(c)
		type idTagged struct {
			ID uuid.UUID `json:"proposal_id"`
			bucketCostProposal
		}
		out := make([]idTagged, 0, len(validProposals))
		for _, prop := range validProposals {
			id, err := d.PG.CreateAIBucketCostProposal(c.Request.Context(), store.AIBucketCostProposal{
				ClusterID:        clusterID,
				CreatedBy:        pp.Email,
				ProviderName:     provider.Name(),
				Snapshot:         snapshot,
				Bucket:           prop.Bucket,
				ProposalAction:   prop.Action,
				ProposalValue:    prop.Value,
				ProposalRisk:     prop.Risk,
				ProposalExplain:  prop.Explanation,
				EstMonthlySaving: prop.EstMonthlySaving,
				Currency:         currency,
			})
			if err != nil {
				warnings = append(warnings, fmt.Sprintf("could not log proposal for %q: %v", prop.Bucket, err))
				out = append(out, idTagged{bucketCostProposal: prop})
				continue
			}
			out = append(out, idTagged{ID: id, bucketCostProposal: prop})
		}

		c.JSON(http.StatusOK, gin.H{
			"ok":            true,
			"summary":       parsed.Summary,
			"proposals":     out,
			"total_saving":  sumBucketSavings(validProposals),
			"currency":      currency,
			"warnings":      warnings,
			"provider_name": provider.Name(),
		})
	}
}

// bucketCostPlanDecide records the operator's verdict.
// POST /api/v1/ai/bucket-cost-proposals/:id/decide
// Body: { decision: "approved"|"discarded"|"edited", applied_value?: object }
func bucketCostPlanDecide(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad proposal id"})
			return
		}
		var body struct {
			Decision     string          `json:"decision"`
			AppliedValue json.RawMessage `json:"applied_value"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
			return
		}
		p, _ := auth.Of(c)
		if err := d.PG.DecideAIBucketCostProposal(c.Request.Context(), id, store.AIBucketCostDecision{
			Decision:     body.Decision,
			DecidedBy:    p.Email,
			AppliedValue: body.AppliedValue,
		}); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// bucketCostLearningSummary serves the AI Learning panel.
// GET /api/v1/ai/bucket-cost-learning?hours=168
func bucketCostLearningSummary(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		hours := 168
		if h := c.Query("hours"); h != "" {
			fmt.Sscanf(h, "%d", &hours)
		}
		sum, err := d.PG.AIBucketCostLearningInWindow(c.Request.Context(), hours)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, sum)
	}
}

// validateBucketCostProposals strips proposals the operator could
// never act on (unknown bucket, unknown action, missing payload for
// set_quota). Returns the surviving slice plus advisory warnings.
func validateBucketCostProposals(in []bucketCostProposal, telemetry []store.BucketAccessStat) ([]bucketCostProposal, []string) {
	known := map[string]bool{}
	for _, b := range telemetry {
		known[b.Bucket] = true
	}
	var warns []string
	out := in[:0]
	for i := range in {
		p := in[i]
		if !known[p.Bucket] {
			warns = append(warns, fmt.Sprintf("dropped proposal: unknown bucket %q", p.Bucket))
			continue
		}
		switch p.Action {
		case "set_quota":
			// Must include a quota_mb in the payload — otherwise the operator
			// has nothing to apply. Fall back to "investigate_tiering" rather
			// than dropping so the signal isn't lost.
			var v struct {
				QuotaMB int64 `json:"quota_mb"`
			}
			if err := json.Unmarshal(p.Value, &v); err != nil || v.QuotaMB <= 0 {
				warns = append(warns, fmt.Sprintf("set_quota for %q has no quota_mb; demoted to investigate_tiering", p.Bucket))
				p.Action = "investigate_tiering"
				p.Value = json.RawMessage(`{}`)
			}
		case "cleanup_uploads", "review_for_deletion", "investigate_tiering":
			// Payload is optional; default to empty object.
			if len(p.Value) == 0 {
				p.Value = json.RawMessage(`{}`)
			}
		default:
			warns = append(warns, fmt.Sprintf("dropped proposal: unknown action %q on %q", p.Action, p.Bucket))
			continue
		}
		// Risk + confidence defaults — never trust the AI to fill them in.
		switch p.Risk {
		case "low", "medium", "high":
		default:
			p.Risk = "medium"
		}
		if p.EstMonthlySaving < 0 {
			p.EstMonthlySaving = 0
		}
		out = append(out, p)
	}
	return out, warns
}

func sumBucketSavings(ps []bucketCostProposal) float64 {
	var total float64
	for _, p := range ps {
		total += p.EstMonthlySaving
	}
	return total
}

// buildBucketCostPrompt — see cost_ai_plan.go for the parallel
// collection-level prompt. Bucket-level differs in action vocabulary
// and the explicit invitation to flag advisory items rather than
// invent fake migrate actions for buckets that aren't directly
// migratable.
func buildBucketCostPrompt(clusterName string, buckets []store.BucketAccessStat, hotPriceTBMonth float64, currency, extra string, max int) string {
	var b strings.Builder
	fmt.Fprintf(&b, `You are a per-bucket lifecycle and cost optimisation assistant for a SeaweedFS S3 gateway.
Goal: propose up to %d concrete bucket-level lifecycle actions that reduce monthly storage cost or operational risk WITHOUT touching hot, actively-read data.

Return STRICT JSON of this shape:
{
  "summary": "1-2 sentence executive summary",
  "proposals": [
    {
      "bucket": "exact bucket name from BUCKET TELEMETRY",
      "action": "set_quota | cleanup_uploads | review_for_deletion | investigate_tiering",
      "value":  <action-specific JSON object>,
      "risk":        "low | medium | high",
      "confidence":  "low | medium | high",
      "explanation": "one paragraph citing the specific numbers that motivated this",
      "est_monthly_saving": <float in %s>
    }
  ]
}

ACTION VOCABULARY:
- "set_quota":            tighten a bucket's quota. value = {"quota_mb": <integer>}. Use when stored size > usage pattern justifies.
- "cleanup_uploads":      run multipart-upload cleanup. value = {"older_than_hours": <int>}. Use when bucket has known orphan multipart waste.
- "review_for_deletion":  flag bucket for manual deletion review. value = {} or {"reason": "..."}. Use ONLY for clear zero-traffic + write-stale buckets.
- "investigate_tiering":  advisory — bucket's underlying collection may belong on cold tier. value = {} or {"target_tier_hint":"..."}. NOT auto-applied.

HARD RULES:
- Never propose deletion of a bucket that has been read in the last 14 days.
- Never propose tightening quota below the bucket's current bytes_out_30d.
- Estimate savings using hot_tier_price_per_TB_month = %.4f %s. If you can't ground the number, set est_monthly_saving = 0 and say so in the explanation.
- Cite specific numbers (reads, writes, bytes) in the explanation — no vague language.
- If telemetry is too thin to support an action, prefer "investigate_tiering" with low confidence over a fabricated quota number.
`, max, currency, hotPriceTBMonth, currency)

	fmt.Fprintf(&b, "\nCLUSTER: %s\n", clusterName)
	fmt.Fprintf(&b, "HOT TIER PRICE: %.4f %s per TB/month\n", hotPriceTBMonth, currency)

	fmt.Fprintln(&b, "\nBUCKET TELEMETRY (last 30 days, sorted by request volume):")
	for _, x := range buckets {
		fmt.Fprintf(&b,
			"  - bucket=%s reads=%d writes=%d bytes_out=%s bytes_in=%s rw_ratio=%.2f\n",
			x.Bucket, x.Reads30d, x.Writes30d,
			humanBytes(int64(x.BytesOut30d)), humanBytes(int64(x.BytesIn30d)), x.ReadWriteRatio)
	}

	if extra = strings.TrimSpace(extra); extra != "" {
		fmt.Fprintf(&b, "\nOPERATOR HINT: %s\n", extra)
	}
	fmt.Fprintln(&b, "\nReturn ONLY the JSON object. No prose before or after.")
	return b.String()
}
