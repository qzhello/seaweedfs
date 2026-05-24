package api

// AI audit-log summariser. Operator picks a time window (and optionally
// narrows by actor / action / target_kind) and gets back a narrative
// instead of having to scroll the table.
//
// Unlike the NL → IAM and limit advisors, this is *read-only*: no
// proposal, no apply, no counterfactual logging. It's a comprehension
// aid, not a decision pipeline. Hence no new table, no decide endpoint,
// just one POST that synthesises and returns.
//
// Cap on entries: prompt-budget. A burst of multipart-aborts or skill
// runs could fill 10k rows in a quiet week; we cap at 500 and tell the
// AI when we truncated so it doesn't claim totals it can't see.

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

const auditSummaryMaxRows = 500

// auditSummary is the JSON shape the AI returns and we pass to the UI.
type auditSummary struct {
	Headline   string   `json:"headline"`   // 1-sentence TL;DR
	Narrative  string   `json:"narrative"`  // 3-6 sentences, prose
	Highlights []string `json:"highlights"` // bullet items: notable single events
	Risks      []string `json:"risks"`      // anomalies / destructive actions worth flagging
}

// auditSummarize handles POST /api/v1/audit/summary
// Body: { hours?, actor?, action?, target_kind?, question? }
//
// "question" is a free-text steering input (e.g. "focus on S3 changes"
// or "who deleted things") — when set, it nudges the AI to weight
// the narrative accordingly. Empty = generic summary.
func auditSummarize(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body struct {
			Hours      int    `json:"hours"`
			Actor      string `json:"actor"`
			Action     string `json:"action"`
			TargetKind string `json:"target_kind"`
			Question   string `json:"question"`
		}
		_ = c.ShouldBindJSON(&body)
		if body.Hours <= 0 {
			body.Hours = 168 // 7 days default — matches the Audit UI's common range
		}
		if body.Hours > 24*90 {
			body.Hours = 24 * 90
		}

		entries, err := d.PG.ListAudit(c.Request.Context(), store.AuditFilter{
			Actor:      strings.TrimSpace(body.Actor),
			Action:     strings.TrimSpace(body.Action),
			TargetKind: strings.TrimSpace(body.TargetKind),
			Since:      time.Now().Add(-time.Duration(body.Hours) * time.Hour),
			Limit:      auditSummaryMaxRows,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		// Empty-window shortcut: tell the UI directly so it can render a
		// friendly empty-state without spending an AI call.
		if len(entries) == 0 {
			c.JSON(http.StatusOK, gin.H{
				"ok":        true,
				"empty":     true,
				"row_count": 0,
				"hours":     body.Hours,
			})
			return
		}

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

		truncated := len(entries) >= auditSummaryMaxRows
		prompt := buildAuditSummaryPrompt(entries, body.Question, body.Hours, truncated)
		raw, aerr := chatter.JSONChat(ctx, prompt)
		if aerr != nil {
			c.JSON(http.StatusOK, gin.H{"ok": false, "error": "AI call failed: " + aerr.Error()})
			return
		}

		var summary auditSummary
		if err := json.Unmarshal([]byte(extractJSONObject(raw)), &summary); err != nil {
			c.JSON(http.StatusOK, gin.H{
				"ok":    false,
				"error": "AI did not return a parseable summary.",
				"raw":   raw,
			})
			return
		}

		// Compute fast facets locally so the UI can render an at-a-glance
		// strip without trusting the AI's counting. The AI's narrative is
		// for humans; the numbers should come from the database.
		facets := auditFacetsFor(entries)

		c.JSON(http.StatusOK, gin.H{
			"ok":            true,
			"summary":       summary,
			"row_count":     len(entries),
			"truncated":     truncated,
			"hours":         body.Hours,
			"facets":        facets,
			"provider_name": provider.Name(),
		})
	}
}

// auditFacetsFor counts the events by action and by actor so the UI
// can show "Top 5 actors" / "Top 5 actions" alongside the narrative.
// Cheap O(n) — runs against the same slice we sent to the AI.
type auditFacetRow struct {
	Key   string `json:"key"`
	Count int    `json:"count"`
}
type auditFacetsResp struct {
	ByAction []auditFacetRow `json:"by_action"`
	ByActor  []auditFacetRow `json:"by_actor"`
	ByKind   []auditFacetRow `json:"by_kind"`
}

func auditFacetsFor(entries []store.AuditEntry) auditFacetsResp {
	by := func(pick func(store.AuditEntry) string) []auditFacetRow {
		counts := map[string]int{}
		for _, e := range entries {
			k := pick(e)
			if k == "" {
				continue
			}
			counts[k]++
		}
		out := make([]auditFacetRow, 0, len(counts))
		for k, n := range counts {
			out = append(out, auditFacetRow{Key: k, Count: n})
		}
		sort.Slice(out, func(i, j int) bool {
			if out[i].Count != out[j].Count {
				return out[i].Count > out[j].Count
			}
			return out[i].Key < out[j].Key
		})
		if len(out) > 5 {
			out = out[:5]
		}
		return out
	}
	return auditFacetsResp{
		ByAction: by(func(e store.AuditEntry) string { return e.Action }),
		ByActor:  by(func(e store.AuditEntry) string { return e.Actor }),
		ByKind:   by(func(e store.AuditEntry) string { return e.TargetKind }),
	}
}

// buildAuditSummaryPrompt formats the audit slice for the AI. We
// deliberately use a compact CSV-ish layout instead of pretty JSON —
// it's denser per token and the AI handles it fine.
func buildAuditSummaryPrompt(entries []store.AuditEntry, question string, hours int, truncated bool) string {
	var b strings.Builder
	b.WriteString(`You are an audit-log summariser for a SeaweedFS storage controller.
Operators need a quick narrative of what changed in the last window without
scrolling raw rows.

Return STRICT JSON of this shape:
{
  "headline":   "1-sentence TL;DR",
  "narrative":  "3-6 sentences of plain prose. Cite specific actors/actions/numbers from the rows below.",
  "highlights": ["bullet — notable single events worth name-checking, e.g. 'alice deleted bucket logs-2024'"],
  "risks":      ["bullet — destructive or unusual actions to double-check, can be empty"]
}

RULES:
- Do NOT invent numbers — only state counts you can derive from the rows shown.
- If rows look truncated, say so in the narrative.
- Group repetitive events instead of listing each (e.g. "12 s3.bucket.quota updates by alice").
- "risks" should call out: deletes, large-batch operations, identity changes,
  circuit-breaker disables, anything that looks anomalous vs the rest.
- Keep prose terse and operator-friendly. No marketing language.

`)
	if strings.TrimSpace(question) != "" {
		fmt.Fprintf(&b, "OPERATOR FOCUS: %s\n\n", strings.TrimSpace(question))
	}
	fmt.Fprintf(&b, "WINDOW: last %d hours, %d rows%s\n\n",
		hours, len(entries),
		map[bool]string{true: " (truncated to the most recent " + fmtInt(auditSummaryMaxRows) + ")", false: ""}[truncated],
	)
	b.WriteString("ROWS (newest first; format: timestamp | actor | action | target_kind | target_id | payload):\n")
	for _, e := range entries {
		// Squash payload to a single line, cap length so one chunky JSON
		// blob doesn't dominate the prompt.
		payload := string(e.Payload)
		payload = strings.ReplaceAll(payload, "\n", " ")
		if len(payload) > 200 {
			payload = payload[:200] + "…"
		}
		fmt.Fprintf(&b, "  %s | %s | %s | %s | %s | %s\n",
			e.At.UTC().Format(time.RFC3339),
			truncStr(e.Actor, 40),
			truncStr(e.Action, 40),
			truncStr(e.TargetKind, 24),
			truncStr(e.TargetID, 40),
			payload,
		)
	}
	b.WriteString("\nReturn ONLY the JSON object. No prose before or after.\n")
	return b.String()
}

// truncStr keeps the prompt rows from blowing up on pathologically long
// fields. Returns "" → "" so empty strings stay empty.
func truncStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func fmtInt(n int) string {
	return fmt.Sprintf("%d", n)
}
