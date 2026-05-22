package api

// AI planner specialised for a single path scope. Reuses the cost
// model + telemetry + the freshly-walked path preview to ask the AI
// for a concrete migration plan limited to that path's collections.
//
// Output shape matches /costs/ai-plan so the UI can render proposals
// with the same component.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

func pathMigrateAIPlan(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		cl, err := loadClusterForFiles(d, c)
		if err != nil {
			return
		}
		ctx := c.Request.Context()
		filerAddr, err := resolveFilerAddr(ctx, d, cl, c.Query("filer"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		var body struct {
			Path          string `json:"path"`
			Recursive     *bool  `json:"recursive,omitempty"`
			Glob          string `json:"glob,omitempty"`
			MinSizeBytes  int64  `json:"min_size_bytes,omitempty"`
			MinAgeDays    int    `json:"min_age_days,omitempty"`
			TargetBackend string `json:"target_backend,omitempty"`
			ExtraContext  string `json:"extra_context,omitempty"`
			MaxProposals  int    `json:"max_proposals,omitempty"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		body.Path = cleanFilerPath(body.Path)
		if body.MaxProposals <= 0 || body.MaxProposals > 10 {
			body.MaxProposals = 3
		}
		recursive := true
		if body.Recursive != nil {
			recursive = *body.Recursive
		}

		// Walk the path. Re-uses the preview walker so the impact
		// numbers seen by the operator match exactly what's in the
		// AI prompt.
		filters := pathMigrateFilters{
			Path:         body.Path,
			Recursive:    recursive,
			Glob:         strings.TrimSpace(body.Glob),
			MinSizeBytes: body.MinSizeBytes,
			MinAgeDays:   body.MinAgeDays,
		}
		walker := newPathWalker(filerAddr, cl, filters)
		_ = walker.walk(ctx, body.Path, 0)
		preview := walker.finalize()

		// Pull cluster cost context — useful for "$X saving" math.
		costs, _ := computeCosts(ctx, d, cl.ID)

		provider, perr := resolveAssistantProvider(ctx, d)
		if perr != nil {
			c.JSON(http.StatusOK, gin.H{"ok": false, "error": "AI provider: " + perr.Error()})
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

		prompt := buildPathMigratePrompt(preview, costs, body.TargetBackend, body.ExtraContext, body.MaxProposals)
		raw, err := chatter.JSONChat(ctx, prompt)
		if err != nil {
			c.JSON(http.StatusOK, gin.H{"ok": false, "error": "AI: " + err.Error()})
			return
		}
		var parsed struct {
			Summary   string                `json:"summary"`
			Proposals []aiMigrationProposal `json:"proposals"`
		}
		if err := json.Unmarshal([]byte(extractJSONObject(raw)), &parsed); err != nil {
			c.JSON(http.StatusOK, gin.H{
				"ok":    false,
				"error": "AI did not return parseable JSON.",
				"raw":   raw,
			})
			return
		}
		sort.Slice(parsed.Proposals, func(i, j int) bool {
			return parsed.Proposals[i].MonthlySaving > parsed.Proposals[j].MonthlySaving
		})
		c.JSON(http.StatusOK, gin.H{
			"ok":           true,
			"path":         body.Path,
			"preview":      preview,
			"proposals":    parsed.Proposals,
			"summary":      parsed.Summary,
			"total_saving": sumSavings(parsed.Proposals),
			"currency":     currencyOf(costs),
		})
	}
}

func currencyOf(c *costsResponse) string {
	if c == nil {
		return "USD"
	}
	return c.Currency
}

func buildPathMigratePrompt(p *pathPreviewResp, costs *costsResponse, target, extra string, max int) string {
	var b strings.Builder
	fmt.Fprintf(&b, `You are planning a path-scoped tiering migration for a SeaweedFS cluster.
The operator is looking at a specific filer path and wants to move that data to cheaper storage WITHOUT impacting active workloads.

Return STRICT JSON:
{
  "summary": "1-2 sentence executive summary",
  "proposals": [
    {
      "title": "short imperative",
      "collection": "collection from impact data (must match)",
      "from_backend": "current backend name",
      "to_backend": "target backend (must exist in available list)",
      "bytes": <integer>,
      "monthly_saving": <float>,
      "currency": "%s",
      "rationale": "why this is safe and what saves",
      "task_command": "the weed shell command (e.g. 'volume.tier.move -collection=X -dest=Y')",
      "risk": "low|medium|high",
      "confidence": "low|medium|high"
    }
  ]
}

RULES:
- Limit to at most %d proposals.
- Only target collections that appear in IMPACT.by_collection — don't invent.
- Only target backends from AVAILABLE BACKENDS list.
- Age distribution matters: files 90d+ are safe to tier cold; <30d should usually stay hot.
- Mixed-extension folders (e.g. logs + thumbnails) signal risk — flag risk>=medium.
- If the operator nominated a target_backend, prefer it but you may override with rationale if unsafe.
- The task_command is a real weed shell command operators will execute; spell it exactly.
- bytes should be the in-path bytes of the affected collection from the impact data, not the cluster-wide collection size.

`, currencyOf(costs), max)

	// Impact snapshot.
	fmt.Fprintln(&b, "IMPACT SNAPSHOT:")
	fmt.Fprintf(&b, "  path:           %s\n", p.Path)
	fmt.Fprintf(&b, "  recursive:      %v\n", p.Recursive)
	if p.Filters.Glob != "" {
		fmt.Fprintf(&b, "  glob:           %s\n", p.Filters.Glob)
	}
	if p.Filters.MinSizeBytes > 0 {
		fmt.Fprintf(&b, "  min_size_bytes: %d\n", p.Filters.MinSizeBytes)
	}
	if p.Filters.MinAgeDays > 0 {
		fmt.Fprintf(&b, "  min_age_days:   %d\n", p.Filters.MinAgeDays)
	}
	fmt.Fprintf(&b, "  matched_files:  %d\n", p.MatchedFiles)
	fmt.Fprintf(&b, "  total_bytes:    %s\n", humanBytes(p.TotalBytes))
	fmt.Fprintf(&b, "  walked_entries: %d (truncated=%v)\n", p.Walked, p.Truncated)

	fmt.Fprintln(&b, "  by_collection:")
	for _, cc := range p.ByCollection {
		fmt.Fprintf(&b, "    - %s: %d files / %s\n", cc.Collection, cc.Files, humanBytes(cc.Bytes))
	}
	fmt.Fprintln(&b, "  by_age:")
	for _, ag := range p.ByAge {
		fmt.Fprintf(&b, "    - %s: %d files / %s\n", ag.Label, ag.Files, humanBytes(ag.Bytes))
	}
	if len(p.ByExtension) > 0 {
		fmt.Fprintln(&b, "  by_extension (top):")
		for i, e := range p.ByExtension {
			if i >= 8 {
				break
			}
			fmt.Fprintf(&b, "    - %s: %d files / %s\n", e.Ext, e.Files, humanBytes(e.Bytes))
		}
	}

	// Available backends from cost context (if pricing is configured).
	if costs != nil && len(costs.Backends) > 0 {
		fmt.Fprintln(&b, "\nAVAILABLE BACKENDS (with current cluster footprint):")
		for _, x := range costs.Backends {
			fmt.Fprintf(&b, "  - %s (kind=%s) @ %s %.4f/TB/month — %s currently\n",
				x.Name, x.Kind, x.Currency, x.PricePerTBMonth, humanBytes(x.PhysicalBytes))
		}
	}
	if costs != nil && costs.HotReferenceBackend != "" {
		fmt.Fprintf(&b, "  hot_reference: %s @ $%.2f/TB/month\n",
			costs.HotReferenceBackend, hotPrice(costs))
	}

	if t := strings.TrimSpace(target); t != "" {
		fmt.Fprintf(&b, "\nOPERATOR PREFERRED TARGET: %s\n", t)
	}
	if e := strings.TrimSpace(extra); e != "" {
		fmt.Fprintf(&b, "OPERATOR HINT: %s\n", e)
	}

	fmt.Fprintln(&b, "\nReturn ONLY the JSON object. No prose before or after.")
	return b.String()
}

func hotPrice(c *costsResponse) float64 {
	for _, b := range c.Backends {
		if b.Name == c.HotReferenceBackend {
			return b.PricePerTBMonth
		}
	}
	return 0
}

// Ensure the cluster id (used by audit) is still exported. The wizard
// currently doesn't audit the AI plan call directly — proposals stay
// as drafts until the operator actually creates a Task elsewhere.
var _ = uuid.New
