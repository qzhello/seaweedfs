package api

// AI volume-balance advisor. `weed shell volume.balance` already computes
// the optimal move plan, so the AI does not generate moves — it reads the
// current per-server volume distribution and answers the questions the
// plan output cannot: how skewed is the cluster, is a balance worth
// running now, and at what scope (whole cluster vs one data center,
// writable-only or not).
//
// Read-only: it returns suggested volume.balance invocations. The
// operator runs them through the normal balance dialog (dry-run first).

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

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/seaweed"
)

var balanceSeverity = map[string]bool{
	"balanced": true, "minor": true, "significant": true, "severe": true,
}

// balanceRecommendation is one suggested `volume.balance` run. Its fields
// map straight onto the balance dialog's form controls.
type balanceRecommendation struct {
	Title      string `json:"title"`
	Collection string `json:"collection"`
	DataCenter string `json:"data_center"`
	Writable   bool   `json:"writable"`
	Rationale  string `json:"rationale"`
	Confidence string `json:"confidence"`
}

type balanceAdviceResp struct {
	GeneratedAt     time.Time               `json:"generated_at"`
	Provider        string                  `json:"provider"`
	Severity        string                  `json:"severity"` // balanced | minor | significant | severe
	Summary         string                  `json:"summary"`
	Recommendations []balanceRecommendation `json:"recommendations"`
}

// balanceAdvisor handles POST /api/v1/clusters/:id/volume/balance/ai-advice.
func balanceAdvisor(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx := c.Request.Context()
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad cluster id"})
			return
		}
		cl, err := d.PG.GetCluster(ctx, id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}

		prov, err := resolveAssistantProvider(ctx, d)
		if err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error()})
			return
		}
		jc, ok := prov.(interface {
			JSONChat(ctx context.Context, prompt string) (string, error)
		})
		if !ok {
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"error": "the configured AI provider does not support structured analysis",
			})
			return
		}

		nodes, err := d.Sw.ListNodesAt(ctx, cl.MasterAddr)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": "topology: " + err.Error()})
			return
		}
		if len(nodes) == 0 {
			c.JSON(http.StatusOK, balanceAdviceResp{
				GeneratedAt:     time.Now().UTC(),
				Provider:        prov.Name(),
				Severity:        "balanced",
				Summary:         "No volume servers reported any volumes.",
				Recommendations: []balanceRecommendation{},
			})
			return
		}

		prompt := buildBalanceAdvisorPrompt(cl.Name, nodes, IsZh(ctx))
		raw, err := jc.JSONChat(ctx, prompt)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": "AI analysis failed: " + err.Error()})
			return
		}
		resp, perr := parseBalanceAdvice(raw)
		if perr != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": perr.Error()})
			return
		}
		resp.GeneratedAt = time.Now().UTC()
		resp.Provider = prov.Name()
		c.JSON(http.StatusOK, resp)
	}
}

// srvAgg rolls the per-disk NodeDiskStats rows up to one row per server —
// volume.balance equalises volume *count* per server, so that is the unit
// the advisor reasons about.
type srvAgg struct {
	server     string
	dc         string
	rack       string
	volumes    int64
	maxVolumes int64
	usedBytes  uint64
}

const balanceAdvisorSystem = `You are a SeaweedFS cluster balance advisor. The shell command volume.balance redistributes volumes so every volume server holds a roughly equal volume count. Your job: judge whether running it is worth it right now, and at what scope.

Guidance:
- If the max and min per-server volume counts are all within ~10% of the mean, the cluster is already balanced — set severity=balanced and return an empty recommendation list.
- A clear skew (one or more servers far above the mean) is worth a cluster-wide balance.
- If the skew is concentrated inside one data center, recommend scoping the run to that data_center instead of the whole cluster.
- Suggest writable=true when read-only volumes dominate and should not be moved.
- severity is one of: balanced, minor, significant, severe.
- Return at most 4 recommendations, best first.`

// buildBalanceAdvisorPrompt aggregates the topology per server, computes
// the spread, and assembles the single-shot prompt with a strict output
// contract.
func buildBalanceAdvisorPrompt(clusterName string, nodes []seaweed.NodeDiskStats, zh bool) string {
	byServer := map[string]*srvAgg{}
	for _, n := range nodes {
		a := byServer[n.Server]
		if a == nil {
			a = &srvAgg{server: n.Server, dc: n.DataCenter, rack: n.Rack}
			byServer[n.Server] = a
		}
		a.volumes += n.VolumeCount
		a.maxVolumes += n.MaxVolumeCount
		a.usedBytes += n.UsedBytes
	}
	servers := make([]*srvAgg, 0, len(byServer))
	for _, a := range byServer {
		servers = append(servers, a)
	}
	sort.Slice(servers, func(i, j int) bool { return servers[i].volumes > servers[j].volumes })

	var minV, maxV, sum int64
	minV = servers[0].volumes
	for _, s := range servers {
		if s.volumes < minV {
			minV = s.volumes
		}
		if s.volumes > maxV {
			maxV = s.volumes
		}
		sum += s.volumes
	}
	mean := float64(sum) / float64(len(servers))

	var b strings.Builder
	b.WriteString(balanceAdvisorSystem)
	fmt.Fprintf(&b, "\n\n## Cluster %q\n", clusterName)
	fmt.Fprintf(&b, "servers=%d | volume count per server: min=%d max=%d mean=%.1f\n",
		len(servers), minV, maxV, mean)

	b.WriteString("\n## Per-server distribution (sorted by volume count, top 50)\n")
	b.WriteString("columns: server | dc | rack | volumes | slot_fill% | used_bytes\n")
	shown := servers
	if len(shown) > 50 {
		shown = shown[:50]
	}
	for _, s := range shown {
		fill := 0.0
		if s.maxVolumes > 0 {
			fill = float64(s.volumes) / float64(s.maxVolumes) * 100
		}
		fmt.Fprintf(&b, "- %s | dc=%s | rack=%s | volumes=%d | fill=%.0f%% | used=%s\n",
			s.server, advisorDC(s.dc), advisorDC(s.rack), s.volumes, fill, humanBytes(int64(s.usedBytes)))
	}

	b.WriteString("\n## Output contract\n")
	b.WriteString("Respond with ONLY a JSON object (no markdown fences) of exactly this shape:\n")
	b.WriteString(`{
  "severity": "balanced|minor|significant|severe",
  "summary": "one or two sentences on how skewed the cluster is",
  "recommendations": [
    {
      "title": "short label, e.g. Cluster-wide balance",
      "collection": "",
      "data_center": "",
      "writable": false,
      "confidence": "high|medium|low",
      "rationale": "why this run, citing the numbers above"
    }
  ]
}` + "\n")
	b.WriteString(`Each recommendation is one volume.balance run. data_center "" means all DCs; collection "" means all collections. If the cluster is already balanced, return an empty recommendations list.` + "\n")
	if zh {
		b.WriteString("summary 与每条 rationale、title 用简体中文书写;server、dc、rack、collection 名保持英文原样。\n")
	} else {
		b.WriteString("Write summary, every title and every rationale in English.\n")
	}
	return b.String()
}

// parseBalanceAdvice extracts and validates the model's JSON, dropping any
// recommendation outside the allowed enums.
func parseBalanceAdvice(raw string) (balanceAdviceResp, error) {
	var out balanceAdviceResp
	var parsed struct {
		Severity        string                  `json:"severity"`
		Summary         string                  `json:"summary"`
		Recommendations []balanceRecommendation `json:"recommendations"`
	}
	if err := json.Unmarshal([]byte(extractJSONObject(raw)), &parsed); err != nil {
		return out, fmt.Errorf("AI returned a response that could not be parsed as JSON")
	}

	out.Severity = strings.TrimSpace(parsed.Severity)
	if !balanceSeverity[out.Severity] {
		out.Severity = "minor"
	}
	out.Summary = strings.TrimSpace(parsed.Summary)
	out.Recommendations = make([]balanceRecommendation, 0, len(parsed.Recommendations))
	for _, r := range parsed.Recommendations {
		r.Title = strings.TrimSpace(r.Title)
		r.Collection = strings.TrimSpace(r.Collection)
		r.DataCenter = strings.TrimSpace(r.DataCenter)
		if r.Title == "" {
			continue
		}
		if !advisorConfidence[r.Confidence] {
			r.Confidence = "medium"
		}
		out.Recommendations = append(out.Recommendations, r)
	}
	return out, nil
}

func advisorDC(s string) string {
	if strings.TrimSpace(s) == "" {
		return "-"
	}
	return s
}
