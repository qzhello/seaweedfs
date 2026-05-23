package api

// NL → S3 IAM policy generator. Operator types a plain-English goal
// ("read-only access to logs-* buckets, no delete"); this endpoint
// snapshots the cluster's bucket list for scope grounding, builds a
// tight prompt, calls the configured AI provider in JSON mode, validates
// the response, then returns a *proposal* the operator must explicitly
// approve before it is applied.
//
// Key design choices (mirrors cost_ai_plan.go):
//   - We never auto-apply. The endpoint returns a proposal; the UI
//     shows it with "Approve & create identity" / "Discard". Approve
//     just prefills the existing EditDialog — it does not call
//     s3.configure itself.
//   - The bucket snapshot is best-effort. If the shell call fails we
//     still send the prompt with an empty bucket list so a degraded
//     cluster doesn't kill the feature entirely.
//   - Validation after parse: actions must be from the allowed set;
//     buckets must match known names or look like a glob.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// allowedS3Actions is the canonical set of action names SeaweedFS S3
// IAM recognises. The bare forms apply cluster-wide; "Read:bucket-name"
// scope form is also valid but the AI returns bare verbs here — the
// operator adds bucket scoping manually if needed.
//
// TODO: pull these from seaweed.S3ActionNames once that const list is
// exported. If the upstream list diverges, update here.
var allowedS3Actions = map[string]struct{}{
	"Read":    {},
	"Write":   {},
	"List":    {},
	"Tagging": {},
	"Admin":   {},
}

// s3PolicyProposal is what the AI returns and what we forward to the UI.
type s3PolicyProposal struct {
	Actions     []string `json:"actions"`
	Buckets     []string `json:"buckets"`
	Explanation string   `json:"explanation"`
	Risk        string   `json:"risk"` // "low" | "medium" | "high"
}

// s3NLPolicy is the handler for POST /api/v1/clusters/:id/s3/nl-policy.
// Body: { "prompt": "…", "scope_hint": "optional bucket prefix" }
// Response: { "proposal": {...}, "warnings": [...] }
func s3NLPolicy(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}

		var body struct {
			Prompt    string `json:"prompt"`
			ScopeHint string `json:"scope_hint,omitempty"`
		}
		if err := c.ShouldBindJSON(&body); err != nil || strings.TrimSpace(body.Prompt) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "prompt is required"})
			return
		}

		ctx := c.Request.Context()

		cl, err := d.PG.GetCluster(ctx, clusterID)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}

		// Snapshot the cluster's bucket list so the AI can ground
		// glob patterns in real names. Best-effort: policy generation
		// still works on a degraded cluster with no bucket list.
		bucketCtx, cancelBuckets := context.WithTimeout(ctx, 15*time.Second)
		defer cancelBuckets()
		buckets, bucketErr := resourceListBuckets(bucketCtx, d.Sw, cl.MasterAddr, cl.WeedBinPath)
		var bucketNames []string
		for _, b := range buckets {
			bucketNames = append(bucketNames, b.Name)
		}

		provider, perr := resolveAssistantProvider(ctx, d)
		if perr != nil {
			c.JSON(http.StatusOK, gin.H{"ok": false, "error": "AI provider not configured: " + perr.Error()})
			return
		}
		chatter, ok := provider.(jsonChatter)
		if !ok {
			c.JSON(http.StatusOK, gin.H{
				"ok":    false,
				"error": "Configured AI provider does not support JSON chat.",
			})
			return
		}

		prompt := buildS3NLPolicyPrompt(body.Prompt, body.ScopeHint, bucketNames)
		raw, err := chatter.JSONChat(ctx, prompt)
		if err != nil {
			c.JSON(http.StatusOK, gin.H{"ok": false, "error": "AI call failed: " + err.Error()})
			return
		}

		var proposal s3PolicyProposal
		if err := json.Unmarshal([]byte(extractJSONObject(raw)), &proposal); err != nil {
			c.JSON(http.StatusOK, gin.H{
				"ok":    false,
				"error": "AI did not return a parseable policy proposal.",
				"raw":   raw,
			})
			return
		}

		warnings := validateS3Proposal(&proposal, bucketNames)

		// Warn if the bucket snapshot was unavailable so the UI can
		// surface a note that glob matching wasn't verified.
		if bucketErr != nil {
			warnings = append(warnings, fmt.Sprintf("bucket list unavailable (%s); bucket patterns unverified", bucketErr.Error()))
		}

		// Persist the proposal so the AI Learning panel can later measure
		// acceptance rate per-risk. Decision side fills in when the
		// operator clicks Approve/Discard. Failure to log is not fatal —
		// the UI still gets its proposal, we just lose this datapoint.
		p, _ := auth.Of(c)
		providerName := ""
		if provider != nil {
			providerName = provider.Name()
		}
		proposalID, logErr := d.PG.CreateAIS3Proposal(c.Request.Context(), store.AIS3Proposal{
			ClusterID:       clusterID,
			CreatedBy:       p.Email,
			ProviderName:    providerName,
			Prompt:          body.Prompt,
			ScopeHint:       body.ScopeHint,
			ProposalActions: proposal.Actions,
			ProposalBuckets: proposal.Buckets,
			ProposalRisk:    proposal.Risk,
			ProposalExplain: proposal.Explanation,
		})
		if logErr != nil {
			// Surface as a warning so the operator knows their decision
			// won't be tracked — but don't block the flow.
			warnings = append(warnings, "could not log proposal for learning: "+logErr.Error())
		}

		c.JSON(http.StatusOK, gin.H{
			"ok":          true,
			"proposal_id": proposalID,
			"proposal":    proposal,
			"warnings":    warnings,
		})
	}
}

// s3LearningSummary returns acceptance metrics for the AI Learning panel.
// GET /api/v1/ai/s3-learning?hours=168
func s3LearningSummary(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		hours := 168
		if h := c.Query("hours"); h != "" {
			fmt.Sscanf(h, "%d", &hours)
		}
		sum, err := d.PG.AIS3LearningInWindow(c.Request.Context(), hours)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, sum)
	}
}

// s3NLPolicyDecide records the operator's verdict on a proposal.
// POST /api/v1/ai/s3-proposals/:id/decide
// Body: { decision: "approved"|"discarded"|"edited",
//         applied_actions: [...], applied_buckets: [...], applied_user: "..." }
//
// The UI calls this from identities.tsx the moment the operator clicks
// Approve & create identity (after the identity is actually saved) or
// Discard. "edited" is sent when the applied action set differs from
// the proposed one — that's the signal the AI was directionally right
// but needed a tweak.
func s3NLPolicyDecide(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad proposal id"})
			return
		}
		var body struct {
			Decision       string   `json:"decision"`
			AppliedActions []string `json:"applied_actions"`
			AppliedBuckets []string `json:"applied_buckets"`
			AppliedUser    string   `json:"applied_user"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
			return
		}
		p, _ := auth.Of(c)
		if err := d.PG.DecideAIS3Proposal(c.Request.Context(), id, store.AIS3ProposalDecision{
			Decision:       body.Decision,
			DecidedBy:      p.Email,
			AppliedActions: body.AppliedActions,
			AppliedBuckets: body.AppliedBuckets,
			AppliedUser:    body.AppliedUser,
		}); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// buildS3NLPolicyPrompt constructs the prompt handed to the AI. It is
// intentionally verbose: concrete bucket names + hard-coded constraints
// reduce hallucinated action names and nonsensical glob patterns.
func buildS3NLPolicyPrompt(userGoal, scopeHint string, buckets []string) string {
	var b strings.Builder

	fmt.Fprintln(&b, `You are an S3 IAM policy assistant for a SeaweedFS tiering controller.
The operator has described their access-control goal in plain English.
Your job is to translate that goal into a minimal, least-privilege S3 IAM policy proposal.

Return STRICT JSON with this exact shape and no other text:
{
  "actions": ["Read", "List"],
  "buckets": ["logs-*", "audit-2024"],
  "explanation": "One paragraph explaining what this policy allows, what it denies, and why it is safe.",
  "risk": "low"
}

FIELD RULES:
- "actions": array of strings. Each element MUST be one of: Read, Write, List, Tagging, Admin.
  Never invent other action names. Use the smallest set that satisfies the goal.
- "buckets": array of strings. May be exact names from KNOWN BUCKETS or glob patterns
  ending in '*' (e.g. "logs-*"). Empty array means ALL buckets — only use [] when the
  operator's goal is explicitly cluster-wide.
- "explanation": 1-3 sentences. Cite which buckets are covered and what is explicitly excluded.
- "risk": exactly one of "low", "medium", "high".
  low  = read-only or narrowly scoped list/tag operations, no data mutation.
  medium = write access, or wildcards covering many buckets.
  high = Admin action, cluster-wide write, or anything that could delete data.

HARD RULES:
- Never include Admin unless the operator explicitly asked for admin access.
- Never include Write or Delete semantics unless the operator explicitly requested them.
- If the operator says "no delete" or "read-only", do NOT include Write or Admin.
- Prefer specific bucket names over '*' whenever the goal names a prefix.
- If no matching bucket is found, return the closest glob (e.g. "logs-*" for "logs buckets").`)

	fmt.Fprintf(&b, "\nOPERATOR GOAL: %s\n", strings.TrimSpace(userGoal))

	if scopeHint = strings.TrimSpace(scopeHint); scopeHint != "" {
		fmt.Fprintf(&b, "SCOPE HINT: %s\n", scopeHint)
	}

	fmt.Fprintln(&b, "\nKNOWN BUCKETS on this cluster:")
	if len(buckets) == 0 {
		fmt.Fprintln(&b, "  (none known — bucket list unavailable; use reasonable globs)")
	} else {
		limit := 50
		if len(buckets) < limit {
			limit = len(buckets)
		}
		for _, name := range buckets[:limit] {
			fmt.Fprintf(&b, "  - %s\n", name)
		}
		if len(buckets) > 50 {
			fmt.Fprintf(&b, "  ... and %d more (not shown; use globs where appropriate)\n", len(buckets)-50)
		}
	}

	fmt.Fprintln(&b, "\nReturn ONLY the JSON object. No prose before or after.")
	return b.String()
}

// validateS3Proposal checks action names against the allowed set and
// verifies that bucket patterns look plausible. Returns a list of
// human-readable warnings — never blocks the response.
func validateS3Proposal(p *s3PolicyProposal, knownBuckets []string) []string {
	var warnings []string

	// Normalise risk to a known value.
	switch p.Risk {
	case "low", "medium", "high":
		// ok
	default:
		p.Risk = "medium"
		warnings = append(warnings, fmt.Sprintf("AI returned unknown risk level %q; defaulted to medium", p.Risk))
	}

	// Validate and filter actions.
	var validActions []string
	for _, a := range p.Actions {
		// Strip any accidental bucket scope ("Read:bucket") — we keep
		// the bare verb and warn so the operator can scope in the form.
		bare := a
		if idx := strings.Index(a, ":"); idx >= 0 {
			bare = a[:idx]
			warnings = append(warnings, fmt.Sprintf("action %q contains scope suffix — stripped to %q; add bucket scope manually in the identity form", a, bare))
		}
		if _, ok := allowedS3Actions[bare]; !ok {
			warnings = append(warnings, fmt.Sprintf("action %q is not a recognised SeaweedFS S3 action and was removed", a))
			continue
		}
		validActions = append(validActions, bare)
	}
	if len(validActions) == 0 {
		validActions = []string{"Read"} // safe fallback
		warnings = append(warnings, "no valid actions remained after validation; defaulted to Read")
	}
	p.Actions = dedupStrings(validActions)

	// Warn on high-risk combinations.
	actionSet := make(map[string]struct{}, len(p.Actions))
	for _, a := range p.Actions {
		actionSet[a] = struct{}{}
	}
	if _, hasAdmin := actionSet["Admin"]; hasAdmin {
		warnings = append(warnings, "proposal includes Admin action — review carefully before approving")
		if p.Risk == "low" {
			p.Risk = "high"
		}
	}
	if _, hasWrite := actionSet["Write"]; hasWrite && p.Risk == "low" {
		p.Risk = "medium"
		warnings = append(warnings, "risk upgraded to medium because Write action was included")
	}

	// Check bucket patterns. Empty = cluster-wide (note but don't block).
	if len(p.Buckets) == 0 {
		warnings = append(warnings, "empty bucket list means this policy applies to ALL buckets")
	} else {
		for _, pat := range p.Buckets {
			if !validBucketPattern(pat) {
				warnings = append(warnings, fmt.Sprintf("bucket pattern %q looks unusual (not a name or glob)", pat))
			}
		}
		// If we have the bucket list, note any glob that matches nothing.
		if len(knownBuckets) > 0 {
			for _, pat := range p.Buckets {
				if strings.Contains(pat, "*") && !globMatchesAny(pat, knownBuckets) {
					warnings = append(warnings, fmt.Sprintf("bucket glob %q matches no known bucket on this cluster", pat))
				}
			}
		}
	}

	return warnings
}

// validBucketPattern returns true for a non-empty string composed of
// bucket-safe characters (alphanumeric, hyphen, underscore, dot, star).
func validBucketPattern(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '-' && r != '_' && r != '.' && r != '*' {
			return false
		}
	}
	return true
}

// globMatchesAny returns true if any name in the list matches the
// simple prefix-glob pattern (only trailing '*' supported).
func globMatchesAny(pattern string, names []string) bool {
	prefix := strings.TrimSuffix(pattern, "*")
	for _, n := range names {
		if strings.HasPrefix(n, prefix) {
			return true
		}
	}
	return false
}

// dedupStrings returns a new slice with duplicates removed, preserving order.
func dedupStrings(ss []string) []string {
	seen := make(map[string]struct{}, len(ss))
	out := make([]string, 0, len(ss))
	for _, s := range ss {
		if _, ok := seen[s]; !ok {
			seen[s] = struct{}{}
			out = append(out, s)
		}
	}
	return out
}
