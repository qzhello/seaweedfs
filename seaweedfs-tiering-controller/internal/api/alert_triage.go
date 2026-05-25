package api

// AI alert triage. Operator picks a window and severity floor and gets
// back a narrative: which alerts are storms, which are unique signals,
// and what's the suggested next step (silence vs investigate).
//
// Like the audit summary (audit_summary.go), this is *read-only*: no
// proposal, no auto-silence, no counterfactual logging. The fingerprint
// + facet counts come from the database; the AI's job is interpretation
// and prioritisation, not arithmetic.
//
// Caps:
//   - 300 raw events into the prompt (alerts churn faster than audit;
//     a noisy storm could push 5k events/day).
//   - Per-fingerprint grouping happens server-side so the AI sees one
//     row per (event_kind, source) pair plus a count, not 300 near-
//     duplicates. This cuts prompt size by an order of magnitude and
//     gives the AI a cleaner signal.

import (
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

const alertTriageMaxRows = 300

// alertTriageSummary is the JSON shape the AI returns.
type alertTriageSummary struct {
	Headline   string                    `json:"headline"`
	Narrative  string                    `json:"narrative"`
	Storms     []alertTriageStormCall    `json:"storms"`     // suggested silence candidates
	Priorities []alertTriagePriorityCall `json:"priorities"` // suggested investigate-first
}

// alertTriageStormCall = "this fingerprint is firing repeatedly, consider
// silencing while you investigate the root cause".
type alertTriageStormCall struct {
	EventKind string `json:"event_kind"`
	Source    string `json:"source"`
	Count     int    `json:"count"`
	Reason    string `json:"reason"`
}

// alertTriagePriorityCall = "this one looks unique/critical, look here first".
type alertTriagePriorityCall struct {
	EventKind string `json:"event_kind"`
	Source    string `json:"source"`
	Severity  string `json:"severity"`
	Reason    string `json:"reason"`
}

// alertFingerprint groups events by (kind, source) — the same pair from
// the same upstream is almost always the same root cause.
type alertFingerprint struct {
	EventKind  string    `json:"event_kind"`
	Source     string    `json:"source"`
	Count      int       `json:"count"`
	FirstFired time.Time `json:"first_fired"`
	LastFired  time.Time `json:"last_fired"`
	Severities []string  `json:"severities"` // distinct severities seen
	Suppressed int       `json:"suppressed"`
}

// alertTriageFacets — at-a-glance counts the UI shows beside the
// narrative. AI prose for humans, numbers from the database.
type alertTriageFacets struct {
	BySeverity   []alertFacetRow    `json:"by_severity"`
	ByKind       []alertFacetRow    `json:"by_kind"`
	BySource     []alertFacetRow    `json:"by_source"`
	Fingerprints []alertFingerprint `json:"fingerprints"`
}

type alertFacetRow struct {
	Key   string `json:"key"`
	Count int    `json:"count"`
}

// alertTriage handles POST /api/v1/alerts/triage
// Body: { hours?: int, severity_min?: "info"|"warning"|"critical", question?: string }
func alertTriage(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body struct {
			Hours       int    `json:"hours"`
			SeverityMin string `json:"severity_min"`
			Question    string `json:"question"`
		}
		_ = c.ShouldBindJSON(&body)
		if body.Hours <= 0 {
			body.Hours = 24
		}
		if body.Hours > 24*30 {
			body.Hours = 24 * 30
		}
		sevFloor := normaliseSeverity(body.SeverityMin)

		// RecentAlertEvents already returns newest-first; we filter
		// in-memory because severity is a small enum and the table
		// isn't massive. If alert volume ever explodes, push the
		// severity filter into SQL.
		events, err := d.PG.RecentAlertEvents(c.Request.Context(), alertTriageMaxRows)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		cutoff := time.Now().Add(-time.Duration(body.Hours) * time.Hour)
		filtered := make([]store.AlertEvent, 0, len(events))
		for _, e := range events {
			if e.FiredAt.Before(cutoff) {
				continue
			}
			if !severityAtOrAbove(e.Severity, sevFloor) {
				continue
			}
			filtered = append(filtered, e)
		}

		if len(filtered) == 0 {
			c.JSON(http.StatusOK, gin.H{
				"ok":        true,
				"empty":     true,
				"row_count": 0,
				"hours":     body.Hours,
			})
			return
		}

		facets := alertFacetsFor(filtered)

		ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
		defer cancel()

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

		truncated := len(events) >= alertTriageMaxRows && len(filtered) > 0 &&
			filtered[len(filtered)-1].FiredAt.After(cutoff)
		prompt := buildAlertTriagePrompt(facets, body.Question, body.Hours, sevFloor, truncated)
		raw, aerr := chatter.JSONChat(ctx, prompt)
		if aerr != nil {
			c.JSON(http.StatusOK, gin.H{"ok": false, "error": "AI call failed: " + aerr.Error()})
			return
		}

		var summary alertTriageSummary
		if err := json.Unmarshal([]byte(extractJSONObject(raw)), &summary); err != nil {
			c.JSON(http.StatusOK, gin.H{
				"ok":    false,
				"error": "AI did not return a parseable triage.",
				"raw":   raw,
			})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"ok":            true,
			"summary":       summary,
			"facets":        facets,
			"row_count":     len(filtered),
			"hours":         body.Hours,
			"severity_min":  sevFloor,
			"truncated":     truncated,
			"provider_name": provider.Name(),
		})
	}
}

// alertFacetsFor builds per-dimension counts + a fingerprint grouping
// keyed by (event_kind, source). One pass; O(n).
//
// The fingerprint list is capped at 25 so the prompt stays bounded
// when the controller is genuinely buried in unique alert kinds; any
// alerts beyond that are still represented in the by_kind / by_source
// counts.
func alertFacetsFor(events []store.AlertEvent) alertTriageFacets {
	bySev := map[string]int{}
	byKind := map[string]int{}
	bySrc := map[string]int{}

	type fpKey struct {
		Kind, Source string
	}
	fps := map[fpKey]*alertFingerprint{}
	for _, e := range events {
		bySev[e.Severity]++
		byKind[e.EventKind]++
		bySrc[e.Source]++

		k := fpKey{e.EventKind, e.Source}
		fp, ok := fps[k]
		if !ok {
			fp = &alertFingerprint{
				EventKind:  e.EventKind,
				Source:     e.Source,
				FirstFired: e.FiredAt,
				LastFired:  e.FiredAt,
			}
			fps[k] = fp
		}
		fp.Count++
		if e.FiredAt.Before(fp.FirstFired) {
			fp.FirstFired = e.FiredAt
		}
		if e.FiredAt.After(fp.LastFired) {
			fp.LastFired = e.FiredAt
		}
		if e.Suppressed {
			fp.Suppressed++
		}
		if !containsString(fp.Severities, e.Severity) {
			fp.Severities = append(fp.Severities, e.Severity)
		}
	}

	fingerprints := make([]alertFingerprint, 0, len(fps))
	for _, fp := range fps {
		sort.Strings(fp.Severities)
		fingerprints = append(fingerprints, *fp)
	}
	sort.Slice(fingerprints, func(i, j int) bool {
		if fingerprints[i].Count != fingerprints[j].Count {
			return fingerprints[i].Count > fingerprints[j].Count
		}
		return fingerprints[i].LastFired.After(fingerprints[j].LastFired)
	})
	if len(fingerprints) > 25 {
		fingerprints = fingerprints[:25]
	}

	return alertTriageFacets{
		BySeverity:   topFacet(bySev, 0),
		ByKind:       topFacet(byKind, 10),
		BySource:     topFacet(bySrc, 10),
		Fingerprints: fingerprints,
	}
}

// containsString lives in cluster_masters.go — reuse it rather
// than redeclaring the same trivial helper.

// Severity ordering for sev-floor filtering. Anything not in the map
// is treated as "info" so we don't accidentally drop useful events.
var sevOrder = map[string]int{
	"info":     0,
	"warning":  1,
	"critical": 2,
}

func normaliseSeverity(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if _, ok := sevOrder[s]; ok {
		return s
	}
	return "info"
}

func severityAtOrAbove(have, floor string) bool {
	return sevOrder[strings.ToLower(have)] >= sevOrder[floor]
}

func buildAlertTriagePrompt(facets alertTriageFacets, question string, hours int, sevFloor string, truncated bool) string {
	var b strings.Builder
	b.WriteString(`You are an alert triage assistant for a SeaweedFS storage controller.
Operators wake up to noisy alert pages and need a 30-second read: which
fingerprints are STORMS (silence + investigate root cause later), which
are PRIORITIES (unique or critical, look at first), and what's the
overall story.

Return STRICT JSON of this shape:
{
  "headline":   "1-sentence summary (e.g. 'Quiet window with one critical IAM event')",
  "narrative":  "3-6 sentences citing specific fingerprints, counts, and recommended next step. No marketing language.",
  "storms": [
    {
      "event_kind": "exact event_kind from the fingerprint list",
      "source":     "exact source",
      "count":      <integer from fingerprint>,
      "reason":     "why this looks like a storm (high count, low diversity, single source)"
    }
  ],
  "priorities": [
    {
      "event_kind": "exact event_kind",
      "source":     "exact source",
      "severity":   "info|warning|critical",
      "reason":     "why this should be investigated first (uniqueness, severity, novelty)"
    }
  ]
}

RULES:
- Use ONLY fingerprints/severities from the lists below. Don't invent.
- A "storm" usually means count >= 10 for the same (event_kind, source).
- "priorities" should be short — usually 1-4 items. Critical-severity
  events with low count are typical candidates.
- If there are no storms, return [] — don't pad.
- If there are no priorities, return [] — silence is fine.
- Don't recommend specific silence durations; the operator picks. Just
  flag the candidate.
- In the narrative, cite numbers from the facets, not impressions.

`)
	if strings.TrimSpace(question) != "" {
		fmt.Fprintf(&b, "OPERATOR FOCUS: %s\n\n", strings.TrimSpace(question))
	}
	fmt.Fprintf(&b, "WINDOW: last %d hours, severity ≥ %s%s\n\n",
		hours, sevFloor,
		map[bool]string{true: " (older events truncated)", false: ""}[truncated],
	)

	fmt.Fprintln(&b, "BY SEVERITY:")
	for _, r := range facets.BySeverity {
		fmt.Fprintf(&b, "  %s = %d\n", r.Key, r.Count)
	}
	fmt.Fprintln(&b, "\nBY KIND (top entries):")
	for _, r := range facets.ByKind {
		fmt.Fprintf(&b, "  %s = %d\n", r.Key, r.Count)
	}
	fmt.Fprintln(&b, "\nBY SOURCE (top entries):")
	for _, r := range facets.BySource {
		fmt.Fprintf(&b, "  %s = %d\n", r.Key, r.Count)
	}

	fmt.Fprintln(&b, "\nFINGERPRINTS (kind | source | count | first | last | severities | suppressed):")
	for _, f := range facets.Fingerprints {
		fmt.Fprintf(&b, "  %s | %s | %d | %s | %s | %s | %d\n",
			f.EventKind, f.Source, f.Count,
			f.FirstFired.UTC().Format(time.RFC3339),
			f.LastFired.UTC().Format(time.RFC3339),
			strings.Join(f.Severities, ","),
			f.Suppressed,
		)
	}

	b.WriteString("\nReturn ONLY the JSON object. No prose before or after.\n")
	return b.String()
}

// topFacet returns the top N entries from a count map, sorted desc.
func topFacet(m map[string]int, n int) []alertFacetRow {
	out := make([]alertFacetRow, 0, len(m))
	for k, v := range m {
		if k == "" {
			continue
		}
		out = append(out, alertFacetRow{Key: k, Count: v})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Key < out[j].Key
	})
	if n > 0 && len(out) > n {
		out = out[:n]
	}
	return out
}
