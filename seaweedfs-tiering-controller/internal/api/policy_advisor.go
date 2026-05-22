package api

// AI migration-policy advisor. Given the cluster's volume-temperature
// picture (per-collection hot/warm/cold/frozen breakdown), the existing
// policies, the configured remote backends and current capacity
// pressure, ask the configured LLM to propose a small set of concrete,
// reviewable migration policies.
//
// The endpoint never writes anything: it returns policy *drafts*. The
// operator reviews each one in the normal policy dialog (which runs the
// real params validation) and saves it there. Every recommendation is
// forced to dry_run=true so an accidental save still moves nothing.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// advisorStrategies / advisorScopes gate what the LLM is allowed to emit —
// anything outside these enums is dropped before the response is returned.
var advisorStrategies = map[string]bool{
	"hot_replicate": true, "warm_ec": true, "cold_cloud": true, "archive": true,
}
var advisorScopes = map[string]bool{
	"global": true, "collection": true, "bucket": true, "regex": true,
}

var advisorConfidence = map[string]bool{"high": true, "medium": true, "low": true}

// policyRecommendation is one AI-proposed policy draft. Its shape is a
// superset of store.Policy's editable fields so the frontend can hand it
// straight to the policy create dialog as a prefill.
type policyRecommendation struct {
	Name            string          `json:"name"`
	ScopeKind       string          `json:"scope_kind"`
	ScopeValue      string          `json:"scope_value"`
	Strategy        string          `json:"strategy"`
	Params          json.RawMessage `json:"params"`
	SampleRate      float64         `json:"sample_rate"`
	DryRun          bool            `json:"dry_run"`
	Rationale       string          `json:"rationale"`
	ExpectedVolumes int64           `json:"expected_volumes"`
	ExpectedBytes   int64           `json:"expected_bytes"`
	Confidence      string          `json:"confidence"`
}

type policyAdviseResp struct {
	GeneratedAt     time.Time              `json:"generated_at"`
	Provider        string                 `json:"provider"`
	Summary         string                 `json:"summary"`
	Recommendations []policyRecommendation `json:"recommendations"`
}

// policyAdvisor handles POST /api/v1/ai/policy-recommendations.
func policyAdvisor(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx := c.Request.Context()

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
		if d.CH == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "temperature data store unavailable"})
			return
		}

		temps, err := d.CH.CollectionTemperatures(ctx)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": "collection temperatures: " + err.Error()})
			return
		}
		if len(temps) == 0 {
			c.JSON(http.StatusOK, policyAdviseResp{
				GeneratedAt:     time.Now().UTC(),
				Provider:        prov.Name(),
				Summary:         "No volume temperature data has been collected yet — run the analytics collector and try again.",
				Recommendations: []policyRecommendation{},
			})
			return
		}

		// Existing policies + backends are best-effort context; a failure
		// here should not block the analysis, only make it less informed.
		policies, _ := d.PG.ListPolicies(ctx)
		backends, _ := d.PG.ListBackends(ctx)
		var forecasts []capacityForecast
		if f, ferr := computeCapacityForecasts(ctx, d); ferr == nil {
			forecasts = f
		}

		prompt := buildPolicyAdvisorPrompt(temps, policies, backends, forecasts, IsZh(ctx))
		raw, err := jc.JSONChat(ctx, prompt)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": "AI analysis failed: " + err.Error()})
			return
		}

		resp, perr := parsePolicyAdvice(raw)
		if perr != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": perr.Error()})
			return
		}
		resp.GeneratedAt = time.Now().UTC()
		resp.Provider = prov.Name()
		c.JSON(http.StatusOK, resp)
	}
}

const policyAdvisorSystem = `You are a storage tiering advisor for a SeaweedFS cluster. You read volume access-temperature data and recommend migration policies that move cold data to cheaper tiers while protecting hot data.

A migration policy selects volumes by scope and applies one strategy. From the data below, propose a small set of high-value, safe policies.

Principles:
- Recommend cold_cloud or archive for collections with large cold/frozen size and low reads_30d.
- Recommend warm_ec for collections with a large cool/warm footprint and only modest reads — erasure coding saves space without a remote hop.
- Never recommend migrating a collection that is mostly hot.
- Do not duplicate an existing enabled policy that already has the same scope and strategy. You may instead suggest a tighter replacement.
- Prefer scope_kind=collection targeting exactly one collection per recommendation — precise and easy to review.
- Return at most 5 recommendations, best first. If nothing is worth migrating, return an empty list.`

// buildPolicyAdvisorPrompt assembles the full single-shot prompt: system
// rules, the strategy/param schema the model must emit, live cluster
// context and the strict output contract.
func buildPolicyAdvisorPrompt(
	temps []store.CollectionTemperature,
	policies []store.Policy,
	backends []store.Backend,
	forecasts []capacityForecast,
	zh bool,
) string {
	// Focus the model on the collections that actually carry cold weight.
	sort.Slice(temps, func(i, j int) bool {
		return temps[i].ColdSize+temps[i].FrozenSize > temps[j].ColdSize+temps[j].FrozenSize
	})
	if len(temps) > 30 {
		temps = temps[:30]
	}

	var b strings.Builder
	b.WriteString(policyAdvisorSystem)

	b.WriteString("\n\n## Strategies and the exact params JSON each one expects\n")
	b.WriteString(`- hot_replicate: {"replication":"010","target_disk_type":"ssd"}` + "\n")
	b.WriteString(`- warm_ec: {"data_shards":10,"parity_shards":4,"min_age_days":7,"max_read_qps":5}` + "\n")
	b.WriteString(`- cold_cloud: {"backend":"<backend name>","bucket":"<s3 bucket>","min_age_days":30,"keep_local_copy":false}` + "\n")
	b.WriteString(`- archive: {"tier":"glacier","min_idle_days":90}` + "\n")
	b.WriteString("scope_kind is one of: global, collection, bucket, regex.\n")

	b.WriteString("\n## Configured remote backends (cold_cloud.backend must be one of these names)\n")
	wrote := false
	for _, bk := range backends {
		if !bk.Enabled {
			continue
		}
		fmt.Fprintf(&b, "- %s (kind=%s, bucket=%s)\n", bk.Name, bk.Kind, bk.Bucket)
		wrote = true
	}
	if !wrote {
		b.WriteString("(none configured — do NOT recommend cold_cloud; prefer warm_ec or archive)\n")
	}

	b.WriteString("\n## Existing policies (do not duplicate; you may propose a tighter replacement)\n")
	if len(policies) == 0 {
		b.WriteString("(none)\n")
	} else {
		for _, p := range policies {
			fmt.Fprintf(&b, "- name=%q strategy=%s scope=%s:%s enabled=%t dry_run=%t\n",
				p.Name, p.Strategy, p.ScopeKind, p.ScopeValue, p.Enabled, p.DryRun)
		}
	}

	b.WriteString("\n## Collection temperature — top collections by cold+frozen size\n")
	b.WriteString("columns: collection | volumes | total_size | reads_30d | counts h/w/cool/cold/frozen | cold_size | frozen_size\n")
	for _, t := range temps {
		fmt.Fprintf(&b, "- %s | vols=%d | size=%s | reads30d=%d | h=%d w=%d cool=%d cold=%d frozen=%d | cold_size=%s | frozen_size=%s\n",
			advisorColl(t.Collection), t.Volumes, humanBytes(int64(t.TotalSize)), t.Reads30d,
			t.HotN, t.WarmN, t.CoolN, t.ColdN, t.FrozenN,
			humanBytes(int64(t.ColdSize)), humanBytes(int64(t.FrozenSize)))
	}

	pressured := make([]capacityForecast, 0, len(forecasts))
	for _, f := range forecasts {
		if f.Status == "warning" || f.Status == "critical" {
			pressured = append(pressured, f)
		}
	}
	if len(pressured) > 0 {
		b.WriteString("\n## Clusters under capacity pressure (migrating frees space here — raise urgency/confidence)\n")
		for _, f := range pressured {
			days := "unknown"
			if f.DaysToFull != nil {
				days = fmt.Sprintf("%.0f", *f.DaysToFull)
			}
			fmt.Fprintf(&b, "- %s | %.0f%% full | ~%s days to full | status=%s\n",
				f.ClusterName, f.PercentFull, days, f.Status)
		}
	}

	b.WriteString("\n## Output contract\n")
	b.WriteString("Respond with ONLY a JSON object (no markdown fences) of exactly this shape:\n")
	b.WriteString(`{
  "summary": "one or two sentences on the overall picture",
  "recommendations": [
    {
      "name": "kebab-case-unique-name",
      "scope_kind": "collection",
      "scope_value": "the collection name",
      "strategy": "cold_cloud",
      "params": { ...strategy-specific params from the schema above... },
      "sample_rate": 1.0,
      "expected_volumes": 0,
      "expected_bytes": 0,
      "confidence": "high|medium|low",
      "rationale": "why this policy, citing the numbers above"
    }
  ]
}` + "\n")
	b.WriteString("expected_volumes/expected_bytes are your estimate of what the policy would move. sample_rate is 0..1.\n")
	if zh {
		b.WriteString("summary 与每条 rationale 用简体中文书写;name、collection 名、参数值保持英文原样。\n")
	} else {
		b.WriteString("Write summary and every rationale in English.\n")
	}
	return b.String()
}

// parsePolicyAdvice extracts the JSON object from the model output and
// validates every recommendation, dropping anything malformed or outside
// the allowed enums. dry_run is always forced true.
func parsePolicyAdvice(raw string) (policyAdviseResp, error) {
	var out policyAdviseResp
	js := extractJSONObject(raw)
	var parsed struct {
		Summary         string                 `json:"summary"`
		Recommendations []policyRecommendation `json:"recommendations"`
	}
	if err := json.Unmarshal([]byte(js), &parsed); err != nil {
		return out, fmt.Errorf("AI returned a response that could not be parsed as JSON")
	}

	out.Summary = strings.TrimSpace(parsed.Summary)
	out.Recommendations = make([]policyRecommendation, 0, len(parsed.Recommendations))
	for _, r := range parsed.Recommendations {
		r.Name = strings.TrimSpace(r.Name)
		r.Strategy = strings.TrimSpace(r.Strategy)
		r.ScopeKind = strings.TrimSpace(r.ScopeKind)
		r.ScopeValue = strings.TrimSpace(r.ScopeValue)
		if r.Name == "" || !advisorStrategies[r.Strategy] || !advisorScopes[r.ScopeKind] {
			continue // outside what the policy model accepts — drop it
		}
		if r.ScopeValue == "" {
			r.ScopeValue = "*"
		}
		// params must be a JSON object; fall back to empty rather than
		// shipping a string/array the policy dialog can't render.
		if tp := bytes.TrimSpace(r.Params); len(tp) == 0 || tp[0] != '{' {
			r.Params = json.RawMessage("{}")
		}
		if r.SampleRate <= 0 || r.SampleRate > 1 {
			r.SampleRate = 1.0
		}
		if !advisorConfidence[r.Confidence] {
			r.Confidence = "medium"
		}
		r.DryRun = true // a draft never enables real moves
		out.Recommendations = append(out.Recommendations, r)
	}
	return out, nil
}

func advisorColl(c string) string {
	if strings.TrimSpace(c) == "" {
		return "(default)"
	}
	return c
}
