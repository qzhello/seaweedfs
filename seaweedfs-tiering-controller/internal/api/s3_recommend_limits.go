package api

// AI Circuit-Breaker limit recommender. Operator clicks "Get AI
// suggestion" on the Circuit Breaker tab; this endpoint:
//   1. Snapshots `s3.circuitBreaker -list` (current limits + recent
//      trigger counts).
//   2. Adds cluster shape (volume count, total size) so the AI can
//      reason about scale, not just hit rate.
//   3. Asks the configured AI provider for a single (type, value)
//      proposal plus a one-line reason and a risk badge.
//   4. Persists the proposal so the AI Learning panel can later
//      measure acceptance rate.
//
// Like NL → IAM, this endpoint NEVER applies anything. The UI shows
// the proposal with an explicit "Apply" button that calls the
// existing s3CircuitBreaker handler. The decision endpoint records
// whether the operator applied as-is, with an edit, or discarded.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// s3LimitProposal is what the AI returns and what we forward to the UI.
type s3LimitProposal struct {
	Type        string `json:"type"`  // "Count" | "MB"
	Value       int64  `json:"value"` // suggested threshold
	Risk        string `json:"risk"`  // "low" | "medium" | "high"
	Explanation string `json:"explanation"`
}

// s3RecommendLimits is the handler for
// POST /api/v1/clusters/:id/s3/recommend-limits
// Body is empty — everything we need is on the server side.
func s3RecommendLimits(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		cl, err := d.PG.GetCluster(c.Request.Context(), clusterID)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
		defer cancel()

		// 1. Current limits + trigger counts via the existing shell.
		cbRaw, cbErr := d.Sw.RunShellReadOnly(ctx, cl.MasterAddr, cl.WeedBinPath,
			"s3.circuitBreaker", []string{"-list"})
		if cbErr != nil {
			// Surface a friendly error — we can't recommend without
			// knowing the current state.
			c.JSON(http.StatusOK, gin.H{
				"ok":    false,
				"error": "Could not read circuit-breaker config: " + cbErr.Error(),
			})
			return
		}

		// Cluster shape is intentionally minimal — the dominant signal
		// for the AI is the trigger-count history in cbRaw. We pass
		// the name + business domain for grounding and let the AI ask
		// for more via additional tool calls if it needs scale data.
		shape := map[string]any{
			"name":            cl.Name,
			"business_domain": cl.BusinessDomain,
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

		prompt := buildS3LimitsPrompt(cl.Name, cbRaw, shape)
		raw, aerr := chatter.JSONChat(ctx, prompt)
		if aerr != nil {
			c.JSON(http.StatusOK, gin.H{"ok": false, "error": "AI call failed: " + aerr.Error()})
			return
		}

		var proposal s3LimitProposal
		if err := json.Unmarshal([]byte(extractJSONObject(raw)), &proposal); err != nil {
			c.JSON(http.StatusOK, gin.H{
				"ok":    false,
				"error": "AI did not return a parseable proposal.",
				"raw":   raw,
			})
			return
		}
		// Validate the proposal — bad type/risk/value shouldn't reach UI.
		warnings := validateLimitProposal(&proposal)

		// 3. Build the snapshot record and persist for learning.
		snapshot, _ := json.Marshal(map[string]any{
			"circuit_breaker_raw": cbRaw,
			"cluster_shape":       shape,
			"current_time":        time.Now().UTC().Format(time.RFC3339),
		})

		p, _ := auth.Of(c)
		proposalID, logErr := d.PG.CreateAIS3LimitProposal(c.Request.Context(), store.AIS3LimitProposal{
			ClusterID:       clusterID,
			CreatedBy:       p.Email,
			ProviderName:    provider.Name(),
			Snapshot:        snapshot,
			ProposalType:    proposal.Type,
			ProposalValue:   proposal.Value,
			ProposalRisk:    proposal.Risk,
			ProposalExplain: proposal.Explanation,
		})
		if logErr != nil {
			warnings = append(warnings, "could not log proposal for learning: "+logErr.Error())
		}

		c.JSON(http.StatusOK, gin.H{
			"ok":          true,
			"proposal_id": proposalID,
			"proposal":    proposal,
			"warnings":    warnings,
			"snapshot": gin.H{
				"circuit_breaker_raw": cbRaw,
				"cluster_shape":       shape,
			},
		})
	}
}

// s3LimitProposalDecide records the operator's verdict on a limit
// proposal. POST /api/v1/ai/s3-limit-proposals/:id/decide
func s3LimitProposalDecide(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad proposal id"})
			return
		}
		var body struct {
			Decision     string `json:"decision"`
			AppliedType  string `json:"applied_type"`
			AppliedValue int64  `json:"applied_value"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
			return
		}
		p, _ := auth.Of(c)
		if err := d.PG.DecideAIS3LimitProposal(c.Request.Context(), id, store.AIS3LimitProposalDecision{
			Decision:     body.Decision,
			DecidedBy:    p.Email,
			AppliedType:  body.AppliedType,
			AppliedValue: body.AppliedValue,
		}); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// s3LimitLearningSummary returns acceptance metrics for the AI Learning panel.
// GET /api/v1/ai/s3-limit-learning?hours=168
func s3LimitLearningSummary(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		hours := 168
		if h := c.Query("hours"); h != "" {
			fmt.Sscanf(h, "%d", &hours)
		}
		sum, err := d.PG.AIS3LimitLearningInWindow(c.Request.Context(), hours)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, sum)
	}
}

// buildS3LimitsPrompt constructs the JSON-chat prompt. Tight + grounded
// in concrete numbers; the AI returns a single proposal object.
func buildS3LimitsPrompt(clusterName, cbRaw string, shape map[string]any) string {
	var b strings.Builder
	b.WriteString(`You are an S3 gateway capacity advisor for a SeaweedFS tiering controller.
The operator wants a single circuit-breaker threshold recommendation based on
current configuration and recent trigger behaviour.

Return STRICT JSON of this shape:
{
  "type":  "Count" | "MB",
  "value": <integer threshold>,
  "risk":  "low" | "medium" | "high",
  "explanation": "1-2 sentences citing the numbers below"
}

RULES:
- Pick the SINGLE most useful adjustment. Don't return multiple proposals.
- "type=Count" caps requests per second; "type=MB" caps bandwidth in MB/s.
- If recent trigger counts are non-zero, the existing limit is biting; propose
  a RAISE so traffic isn't being throttled unnecessarily. Cite the trigger count.
- If trigger counts are zero AND the cluster looks small/idle, you may propose
  the same or a tighter limit only if there is a clear safety reason.
- "value" must be a positive integer. Round to a clean number.
- "risk":
    low    = small adjustment, well within current cluster capacity
    medium = larger adjustment OR moving from disabled to enabled
    high   = >2x current limit, OR removing protection entirely
- Cite at least one specific number from the data below in "explanation".

`)
	fmt.Fprintf(&b, "CLUSTER: %s\n", clusterName)
	if v, ok := shape["business_domain"]; ok && v != "" {
		fmt.Fprintf(&b, "  business_domain: %v\n", v)
	}

	b.WriteString("\nCURRENT CIRCUIT BREAKER STATE (from `s3.circuitBreaker -list`):\n")
	b.WriteString("```\n")
	// Cap the raw blob so an unusually verbose shell output doesn't
	// dominate the prompt budget.
	if len(cbRaw) > 4000 {
		cbRaw = cbRaw[:4000] + "\n…(truncated)\n"
	}
	b.WriteString(cbRaw)
	if !strings.HasSuffix(cbRaw, "\n") {
		b.WriteString("\n")
	}
	b.WriteString("```\n")
	b.WriteString("\nReturn ONLY the JSON object. No prose before or after.\n")
	return b.String()
}

// validateLimitProposal patches obvious issues (e.g. negative values
// clamped to 0, unknown type rewritten to Count) and emits warnings
// the UI can show next to the proposal. We do NOT reject — operators
// can still review and discard.
func validateLimitProposal(p *s3LimitProposal) []string {
	var warnings []string
	if p.Type != "Count" && p.Type != "MB" {
		warnings = append(warnings, fmt.Sprintf("AI returned type=%q; expected Count or MB", p.Type))
		p.Type = "Count"
	}
	if p.Value <= 0 {
		warnings = append(warnings, fmt.Sprintf("AI returned non-positive value=%d; forcing to 1", p.Value))
		p.Value = 1
	}
	if p.Risk != "low" && p.Risk != "medium" && p.Risk != "high" {
		warnings = append(warnings, fmt.Sprintf("AI returned risk=%q; defaulting to medium", p.Risk))
		p.Risk = "medium"
	}
	if strings.TrimSpace(p.Explanation) == "" {
		warnings = append(warnings, "AI returned no explanation")
	}
	return warnings
}
