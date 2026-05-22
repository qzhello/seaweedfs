package api

// AI migration planner. Operator clicks "Let AI plan migrations" on
// the Costs dashboard; this endpoint snapshots the current cost
// breakdown + gateway telemetry + temperature features into a single
// prompt and asks the configured AI provider for up to 5 concrete
// migration proposals. Each proposal is returned as a draft Task the
// operator can review and approve.
//
// Key design choices:
//   - We don't auto-create Tasks. The endpoint returns drafts; the UI
//     shows them with checkbox + estimated saving, and the operator
//     explicitly clicks "Create as Task" on the ones they accept.
//   - The prompt is sized so the AI sees the actual numbers (top
//     collections, their temperatures, their backends) — not a vague
//     description. Bad ROI in, bad plan out.
//   - JSON chat — same provider contract as analyzer_ai / ops_template.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// aiMigrationProposal mirrors what the AI returns + what the UI
// renders. `task_command` is the ops shell command the operator could
// run if they accept the proposal as-is.
type aiMigrationProposal struct {
	Title           string  `json:"title"`
	Collection      string  `json:"collection"`
	FromBackend     string  `json:"from_backend"`
	ToBackend       string  `json:"to_backend"`
	Bytes           int64   `json:"bytes"`
	MonthlySaving   float64 `json:"monthly_saving"`
	Currency        string  `json:"currency"`
	Rationale       string  `json:"rationale"`
	TaskCommand     string  `json:"task_command"`
	Risk            string  `json:"risk"`
	Confidence      string  `json:"confidence"`
}

func aiPlanMigrations(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		idStr := c.Query("cluster_id")
		if idStr == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "cluster_id is required"})
			return
		}
		clusterID, err := uuid.Parse(idStr)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster_id"})
			return
		}
		var body struct {
			MaxProposals int    `json:"max_proposals,omitempty"`
			ExtraContext string `json:"extra_context,omitempty"`
		}
		_ = c.BindJSON(&body)
		if body.MaxProposals <= 0 || body.MaxProposals > 20 {
			body.MaxProposals = 5
		}

		ctx := c.Request.Context()

		costs, err := computeCosts(ctx, d, clusterID)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": "cost calc: " + err.Error()})
			return
		}
		// Gateway telemetry is best-effort — if the seed/migration
		// hasn't been applied yet we still want to return a useful
		// plan from temperature + costs alone.
		buckets, _ := d.CH.BucketAccessSummary(ctx, 50)

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

		prompt := buildMigrationPlanPrompt(costs, buckets, body.ExtraContext, body.MaxProposals)
		raw, err := chatter.JSONChat(ctx, prompt)
		if err != nil {
			c.JSON(http.StatusOK, gin.H{"ok": false, "error": "AI call failed: " + err.Error()})
			return
		}
		var parsed struct {
			Proposals []aiMigrationProposal `json:"proposals"`
			Summary   string                `json:"summary"`
		}
		if err := json.Unmarshal([]byte(extractJSONObject(raw)), &parsed); err != nil {
			c.JSON(http.StatusOK, gin.H{
				"ok":    false,
				"error": "AI did not return a parseable plan.",
				"raw":   raw,
			})
			return
		}
		// Sort by estimated saving so the UI's first-tile checkbox is
		// the biggest win.
		sort.Slice(parsed.Proposals, func(i, j int) bool {
			return parsed.Proposals[i].MonthlySaving > parsed.Proposals[j].MonthlySaving
		})
		c.JSON(http.StatusOK, gin.H{
			"ok":         true,
			"proposals":  parsed.Proposals,
			"summary":    parsed.Summary,
			"total_saving": sumSavings(parsed.Proposals),
			"currency":   costs.Currency,
		})
	}
}

func sumSavings(ps []aiMigrationProposal) float64 {
	var total float64
	for _, p := range ps {
		total += p.MonthlySaving
	}
	return total
}

func buildMigrationPlanPrompt(costs *costsResponse, buckets []store.BucketAccessStat, extra string, max int) string {
	// We pass a hand-shaped table of the top collections + their cost
	// share + the current backend, plus a list of available backends
	// with prices. The AI's job is to pick the best transitions.
	var b strings.Builder
	fmt.Fprintf(&b, `You are a storage cost optimisation assistant for a SeaweedFS tiering controller.
Goal: propose up to %d concrete migration tasks that maximise monthly cost savings WITHOUT risking access latency for active data.

Return STRICT JSON of this shape:
{
  "summary": "1-2 sentence executive summary",
  "proposals": [
    {
      "title": "short imperative — e.g. 'Tier logs-archive to S3-IA'",
      "collection": "collection name from input",
      "from_backend": "current backend name",
      "to_backend": "target backend name from available list",
      "bytes": <integer bytes affected>,
      "monthly_saving": <float, in the same currency as cost.currency>,
      "currency": "%s",
      "rationale": "one paragraph: why this move is safe + savings math",
      "task_command": "the weed shell command that would execute this (e.g. 'volume.tier.move -collection=X -dest=Y')",
      "risk": "low|medium|high",
      "confidence": "low|medium|high"
    }
  ]
}

HARD RULES:
- Only propose moves where the target backend exists in AVAILABLE BACKENDS.
- Don't propose moving hot data (RECENTLY ACCESSED collections / buckets) to cold storage.
- Prefer moving cold and frozen volumes first.
- If telemetry shows a bucket has been accessed in the last 7 days, mark its proposal risk >= medium and confidence <= medium.
- Skip collections whose total bytes are negligible (< 100GB) unless they're frozen.
- Use the rationale field to cite specific numbers (bytes, $/month, last access).
`, max, costs.Currency)

	fmt.Fprintln(&b, "\nCURRENT COSTS:")
	fmt.Fprintf(&b, "  total_monthly_cost: %s %.2f\n", costs.Currency, costs.TotalMonthlyCost)
	fmt.Fprintf(&b, "  counterfactual_all_hot_3x: %s %.2f\n", costs.Currency, costs.CounterfactualCost)
	fmt.Fprintf(&b, "  realised_monthly_saving: %s %.2f\n", costs.Currency, costs.MonthlySaving)
	fmt.Fprintf(&b, "  hot_reference_backend: %s\n", costs.HotReferenceBackend)

	fmt.Fprintln(&b, "\nAVAILABLE BACKENDS:")
	for _, x := range costs.Backends {
		fmt.Fprintf(&b, "  - %s (kind=%s) at %s %.4f /TB/month — %s of %d volume(s)\n",
			x.Name, x.Kind, x.Currency, x.PricePerTBMonth,
			humanBytes(x.PhysicalBytes), x.VolumeCount)
	}

	fmt.Fprintln(&b, "\nTOP COLLECTIONS BY SPEND:")
	for _, cc := range costs.TopCollections {
		fmt.Fprintf(&b, "  - collection=%s  bytes=%s  monthly_cost=%s %.2f\n    by_backend:",
			displayCollection(cc.Collection), humanBytes(cc.PhysicalBytes), costs.Currency, cc.MonthlyCost)
		for bn, by := range cc.ByBackendBytes {
			fmt.Fprintf(&b, " %s=%s", bn, humanBytes(by))
		}
		fmt.Fprintln(&b)
	}

	fmt.Fprintln(&b, "\nEXISTING RECOMMENDATIONS (from rule-based engine — refine or override these):")
	for _, r := range costs.Recommendations {
		fmt.Fprintf(&b, "  - %s → %s for collection=%s, bytes=%s, est. saving=%s %.2f. %s\n",
			r.FromBackend, r.ToBackend, displayCollection(r.Collection),
			humanBytes(r.Bytes), r.Currency, r.MonthlySaving, r.Rationale)
	}

	fmt.Fprintln(&b, "\nGATEWAY TELEMETRY (per-bucket, last 30 days):")
	if len(buckets) == 0 {
		fmt.Fprintln(&b, "  (no telemetry available; reason about temperature and cost only)")
	} else {
		// Top 20 most-trafficked buckets — anything quieter than that
		// is unlikely to materially shift the plan.
		limit := 20
		if len(buckets) < limit {
			limit = len(buckets)
		}
		for _, x := range buckets[:limit] {
			fmt.Fprintf(&b,
				"  - bucket=%s reads=%d writes=%d bytes_out=%s bytes_in=%s rw_ratio=%.2f\n",
				x.Bucket, x.Reads30d, x.Writes30d,
				humanBytes(int64(x.BytesOut30d)), humanBytes(int64(x.BytesIn30d)), x.ReadWriteRatio)
		}
	}

	if extra = strings.TrimSpace(extra); extra != "" {
		fmt.Fprintf(&b, "\nOPERATOR HINT: %s\n", extra)
	}

	fmt.Fprintln(&b, "\nReturn ONLY the JSON object. No prose before or after.")
	return b.String()
}

func displayCollection(c string) string {
	if c == "" {
		return "(default)"
	}
	return c
}

// humanBytes renders a byte count as a short human-readable string.
// Kept local to this file so the AI prompt doesn't change subtly when
// the broader formatter does.
func humanBytes(n int64) string {
	if n < 1024 {
		return fmt.Sprintf("%dB", n)
	}
	units := []string{"KB", "MB", "GB", "TB", "PB"}
	f := float64(n)
	i := -1
	for f >= 1024 && i < len(units)-1 {
		f /= 1024
		i++
	}
	return fmt.Sprintf("%.2f%s", f, units[i])
}

// Avoid the unused-import linter complaint when the AI provider stub
// in some builds doesn't reference context.
var _ = context.Background
