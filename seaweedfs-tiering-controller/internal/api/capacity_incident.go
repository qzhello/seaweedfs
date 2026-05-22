package api

// Capacity incident endpoints — the operator-facing half of the
// auto-pause closed loop.
//
//	executor hits a capacity wall  →  store.OpenCapacityIncident
//	scheduler skips held clusters  →  tiering paused
//	GET  /incidents                →  surfaced on the dashboard
//	POST /incidents/:id/analyze     →  AI analyst brief (root cause + 3 actions)
//	POST /incidents/:id/resolve     →  lift the hold, resume tiering
//
// The AI brief mirrors the cost_ai_plan.go contract: build a prompt with
// the real numbers, JSONChat, parse strict JSON. Bad data in, bad brief
// out — so we feed live capacity, per-collection footprint + 7-day
// growth, and backend pricing.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// incidentReport is the AI analyst brief persisted on capacity_incidents.ai_report.
type incidentReport struct {
	RootCause  string           `json:"root_cause"`
	Summary    string           `json:"summary"`
	Actions    []incidentAction `json:"actions"`
	Provider   string           `json:"provider"`
	AnalyzedAt time.Time        `json:"analyzed_at"`
}

// incidentAction is one recommended remediation. Cost and ETA stay
// free-text strings — the AI gives approximate human values and forcing
// structured floats would invent false precision.
type incidentAction struct {
	Title   string `json:"title"`
	Kind    string `json:"kind"` // expand | cold_migrate | pause | other
	Detail  string `json:"detail"`
	EstCost string `json:"est_cost"`
	EstETA  string `json:"est_eta"`
	Risk    string `json:"risk"` // low | medium | high
}

func listCapacityIncidents(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		status := c.Query("status") // "", "open", "resolved"
		limit, _ := strconv.Atoi(c.DefaultQuery("limit", "100"))
		items, err := d.PG.ListCapacityIncidents(c.Request.Context(), status, limit)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": items, "total": len(items)})
	}
}

func getCapacityIncident(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		inc, err := d.PG.GetCapacityIncident(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, inc)
	}
}

// resolveCapacityIncident closes an incident and lifts the capacity hold —
// the scheduler resumes tiering for that cluster on its next pass.
func resolveCapacityIncident(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		if err := d.PG.ResolveCapacityIncident(c.Request.Context(), id, userOf(c)); err != nil {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(c.Request.Context(), userOf(c), "resolve", "capacity_incident", id.String(), nil)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// analyzeCapacityIncident runs the AI analyst over one incident and
// persists the brief. Idempotent — re-running overwrites the prior brief.
func analyzeCapacityIncident(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		ctx := c.Request.Context()
		inc, err := d.PG.GetCapacityIncident(ctx, id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		cl, err := d.PG.GetCluster(ctx, inc.ClusterID)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "cluster: " + err.Error()})
			return
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

		raw, err := chatter.JSONChat(ctx, buildCapacityIncidentPrompt(ctx, d, inc, cl))
		if err != nil {
			c.JSON(http.StatusOK, gin.H{"ok": false, "error": "AI call failed: " + err.Error()})
			return
		}
		var report incidentReport
		if err := json.Unmarshal([]byte(extractJSONObject(raw)), &report); err != nil {
			c.JSON(http.StatusOK, gin.H{
				"ok":    false,
				"error": "AI did not return a parseable brief.",
				"raw":   raw,
			})
			return
		}
		report.Provider = provider.Name()
		report.AnalyzedAt = time.Now()
		if err := d.PG.SetIncidentAIReport(ctx, id, report); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		_ = d.PG.Audit(ctx, userOf(c), "analyze", "capacity_incident", id.String(), nil)
		c.JSON(http.StatusOK, gin.H{"ok": true, "report": report})
	}
}

func buildCapacityIncidentPrompt(ctx context.Context, d Deps, inc *store.CapacityIncident, cl *store.Cluster) string {
	var b strings.Builder
	b.WriteString(`You are a storage capacity incident analyst for a SeaweedFS tiering controller.
A cluster has hit a capacity wall: a tiering task failed with a capacity-class error, and
tiering for this cluster is now auto-paused. Produce a concise incident brief.

Return STRICT JSON of this shape:
{
  "root_cause": "1-2 sentences — the most likely reason the cluster ran out of room",
  "summary": "1 sentence an on-call engineer can act on",
  "actions": [
    {
      "title": "short imperative",
      "kind": "expand|cold_migrate|pause|other",
      "detail": "what to do, concretely, citing the numbers below",
      "est_cost": "rough cost impact, e.g. '+$420/mo', 'saves ~$1,200/mo', or 'n/a'",
      "est_eta": "rough time-to-effect, e.g. '~2h', '~30m', '1-2 days'",
      "risk": "low|medium|high"
    }
  ]
}

RULES:
- Return EXACTLY 3 actions, ordered best-first.
- Cover a mix: at least one fast-relief action and one structural fix.
- Ground every number in the data below. If data is missing, say so rather than inventing.
- Keep each field short — this renders in a dashboard card.
`)

	fmt.Fprintf(&b, "\nINCIDENT:\n  cluster: %s\n  triggered_at: %s\n  failure_message: %q\n",
		cl.Name, inc.TriggeredAt.Format(time.RFC3339), inc.FailureMessage)

	// Live capacity snapshot — the headline "how full is it" signal.
	if _, nodes, ferr := fetchClusterVolumes(ctx, d.Sw, cl.MasterAddr, cl.WeedBinPath); ferr == nil {
		var volCount, maxVol, freeVol int64
		var usedBytes uint64
		for _, n := range nodes {
			volCount += n.VolumeCount
			maxVol += n.MaxVolumeCount
			freeVol += n.FreeVolumeCount
			usedBytes += n.UsedBytes
		}
		fmt.Fprintf(&b, "\nCAPACITY (live):\n  nodes: %d\n  volume_slots: %d used / %d max (%d free)\n  used_bytes: %s\n",
			len(nodes), volCount, maxVol, freeVol, humanBytes(int64(usedBytes)))
	} else {
		fmt.Fprintf(&b, "\nCAPACITY: unavailable (%v)\n", ferr)
	}

	// Per-collection footprint + temperature + 7-day growth — tells the
	// AI which collection is the bulk and whether it's cold enough to move.
	if d.CH != nil {
		if temps, terr := d.CH.CollectionTemperatures(ctx); terr == nil && len(temps) > 0 {
			weekAgo := collectionSizeAt(ctx, d.CH, time.Now().Add(-7*24*time.Hour))
			sort.Slice(temps, func(i, j int) bool { return temps[i].TotalSize > temps[j].TotalSize })
			fmt.Fprintln(&b, "\nTOP COLLECTIONS (by size; cold+frozen bytes are migration candidates):")
			limit := 12
			if len(temps) < limit {
				limit = len(temps)
			}
			for _, t := range temps[:limit] {
				line := fmt.Sprintf("  - %s  size=%s  cold+frozen=%s  reads_7d=%d",
					displayCollection(t.Collection), humanBytes(int64(t.TotalSize)),
					humanBytes(int64(t.ColdSize+t.FrozenSize)), t.Reads7d)
				if was, ok := weekAgo[t.Collection]; ok && was > 0 {
					delta := (float64(t.TotalSize) - float64(was)) / float64(was) * 100
					line += fmt.Sprintf("  7d_growth=%+.0f%%", delta)
				}
				fmt.Fprintln(&b, line)
			}
		}
	}

	// Backend pricing — lets the AI attach a cost figure to cold-migration.
	if prices, perr := d.PG.ListBackendPricing(ctx); perr == nil && len(prices) > 0 {
		fmt.Fprintln(&b, "\nAVAILABLE BACKENDS (for cold-migration cost math):")
		for _, p := range prices {
			fmt.Fprintf(&b, "  - %s (kind=%s) at %s %.4f /TB/month\n",
				p.Name, p.Kind, p.Currency, p.StoragePricePerTBMonth)
		}
	}

	fmt.Fprintln(&b, "\nReturn ONLY the JSON object. No prose before or after.")
	return b.String()
}

// collectionSizeAt aggregates per-collection total size from the feature
// snapshot nearest `at`. Best-effort — an empty map on any error so the
// growth column simply drops out of the prompt.
func collectionSizeAt(ctx context.Context, ch *store.CH, at time.Time) map[string]uint64 {
	out := map[string]uint64{}
	snap, err := ch.VolumeFeaturesSnapshotAt(ctx, at)
	if err != nil {
		return out
	}
	for _, f := range snap {
		out[f.Collection] += f.SizeBytes
	}
	return out
}
