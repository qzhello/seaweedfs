package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/skill"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// listSkills returns every skill with the latest stats merged in.
func listSkills(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx := c.Request.Context()
		scope := c.Query("scope")
		rows, err := d.PG.ListSkills(ctx, scope)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		stats, err := d.PG.SkillStatsAll(ctx)
		if err != nil {
			d.Log.Sugar().Warnw("skill stats", "err", err)
			stats = map[string]store.SkillStats{}
		}
		// Collapse to the latest version per key. ListSkills already returns
		// rows sorted by (category, key, version DESC) so the first row we
		// see for each key IS the latest — we just take that. Walking the
		// pre-sorted slice (instead of a map) preserves a stable order so
		// the UI doesn't reshuffle cards on every refresh.
		seen := map[string]struct{}{}
		out := make([]gin.H, 0, len(rows))
		for _, r := range rows {
			if _, ok := seen[r.Key]; ok {
				continue
			}
			seen[r.Key] = struct{}{}
			out = append(out, gin.H{
				"id":          r.ID,
				"key":         r.Key,
				"name":        r.Name,
				"scope":       r.Scope,
				"risk_level":  r.RiskLevel,
				"category":    r.Category,
				"version":     r.Version,
				"enabled":     r.Enabled,
				"definition":  r.Definition,
				"updated_at":  r.UpdatedAt,
				"updated_by":  r.UpdatedBy,
				"stats":       stats[r.Key],
			})
		}
		c.JSON(http.StatusOK, gin.H{"items": out})
	}
}

func getSkillHistory(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		key := c.Param("key")
		rows, err := d.PG.SkillHistory(c.Request.Context(), key, 50)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": rows})
	}
}

type upsertSkillReq struct {
	Key        string          `json:"key" binding:"required"`
	Name       string          `json:"name" binding:"required"`
	Category   string          `json:"category"`
	RiskLevel  string          `json:"risk_level" binding:"required"`
	Definition json.RawMessage `json:"definition" binding:"required"`
	ChangeNote string          `json:"change_note"`
}

// upsertSkill creates a new custom Skill version. System skills are managed at
// startup and are not editable through this endpoint.
func upsertSkill(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req upsertSkillReq
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if err := skill.Validate(req.Definition); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		// Refuse to override a system skill via the custom path.
		cur, err := d.PG.GetSkillCurrent(c.Request.Context(), req.Key)
		if err == nil && cur != nil && cur.Scope == "system" {
			c.JSON(http.StatusConflict, gin.H{"error": "key is owned by a system skill; pick a different key"})
			return
		}
		actor, _ := c.Get("user")
		actorStr, _ := actor.(string)
		if actorStr == "" {
			actorStr = "unknown"
		}
		saved, err := d.PG.UpsertCustomSkill(c.Request.Context(), store.Skill{
			Key:        req.Key,
			Name:       req.Name,
			Category:   firstNonEmpty(req.Category, "general"),
			RiskLevel:  req.RiskLevel,
			Definition: req.Definition,
			ChangeNote: req.ChangeNote,
		}, actorStr)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if d.Skills != nil {
			_ = d.Skills.Reload(c.Request.Context())
		}
		c.JSON(http.StatusOK, saved)
	}
}

type setEnabledReq struct {
	Enabled bool `json:"enabled"`
}

func toggleSkill(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		key := c.Param("key")
		var req setEnabledReq
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		actor, _ := c.Get("user")
		actorStr, _ := actor.(string)
		if err := d.PG.SetSkillEnabled(c.Request.Context(), key, req.Enabled, actorStr); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if d.Skills != nil {
			_ = d.Skills.Reload(c.Request.Context())
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// validateSkillDef is a stateless preview endpoint used by the SOP editor.
// json.RawMessage's UnmarshalJSON copies bytes as-is, so ShouldBindJSON works.
func validateSkillDef(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var raw json.RawMessage
		if err := c.ShouldBindJSON(&raw); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if err := skill.Validate(raw); err != nil {
			c.JSON(http.StatusOK, gin.H{"ok": false, "error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// jsonChatter is the minimal AI surface needed for SOP drafting. Mirrors the
// type assertion in aireview/orchestrator.go so we don't need to widen the
// public Provider interface.
type jsonChatter interface {
	JSONChat(ctx context.Context, prompt string) (string, error)
}

// draftSkillFromText turns operator-pasted content into a skill draft. The
// fast path is a direct JSON paste (no AI call). When the text isn't JSON,
// we ask the configured AI provider to convert prose/markdown into a skill
// definition matching our schema, then validate the result server-side.
//
// Response shape: { ok, draft: { key, name, category, risk_level, definition },
//                  error?, mode: "json"|"ai" }
func draftSkillFromText(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body struct {
			Text         string `json:"text"`
			HintCategory string `json:"hint_category"`
			HintRisk     string `json:"hint_risk"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		text := strings.TrimSpace(body.Text)
		if text == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "text required"})
			return
		}

		// Path 1 — pasted JSON. Try parsing immediately; if it's a valid
		// skill schema we return as-is, no AI involvement.
		if draft, ok := tryParseJSONDraft(text); ok {
			c.JSON(http.StatusOK, gin.H{"ok": true, "mode": "json", "draft": draft})
			return
		}

		// Path 2 — prose. Hand off to the AI provider.
		chatter, ok := d.AI.(jsonChatter)
		if !ok {
			c.JSON(http.StatusOK, gin.H{
				"ok":    false,
				"mode":  "ai",
				"error": "AI provider is not configured (current provider can't do free-form chat). Paste raw JSON instead, or configure OpenAI/Anthropic in AI Config.",
			})
			return
		}

		prompt := buildSkillDraftPrompt(text, body.HintCategory, body.HintRisk)
		raw, err := chatter.JSONChat(c.Request.Context(), prompt)
		if err != nil {
			c.JSON(http.StatusOK, gin.H{"ok": false, "mode": "ai", "error": "AI call failed: " + err.Error()})
			return
		}
		// LLMs frequently wrap JSON in markdown fences or chat preamble.
		// Strip both before validating.
		cleaned := extractJSONObject(raw)
		draft, ok := tryParseJSONDraft(cleaned)
		if !ok {
			c.JSON(http.StatusOK, gin.H{
				"ok":     false,
				"mode":   "ai",
				"error":  "AI did not return a valid skill JSON. Try rephrasing or paste raw JSON instead.",
				"raw":    raw,
			})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "mode": "ai", "draft": draft})
	}
}

// SkillDraft is the import-modal contract — flat shape that maps 1:1 to the
// SOPEditor's SOPDraft on the frontend.
type SkillDraft struct {
	Key        string          `json:"key"`
	Name       string          `json:"name"`
	Category   string          `json:"category"`
	RiskLevel  string          `json:"risk_level"`
	Definition json.RawMessage `json:"definition"`
}

// tryParseJSONDraft accepts either:
//   (a) the full draft envelope:   { key, name, category, risk_level, definition: {...} }
//   (b) just the definition body:  { summary, steps, ... }
// In case (b) we synthesize sensible defaults so the editor has something to
// show. Returns (draft, true) only when the definition validates.
func tryParseJSONDraft(text string) (*SkillDraft, bool) {
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal([]byte(text), &envelope); err != nil {
		return nil, false
	}

	// Detect envelope vs bare-definition. An envelope has at least one of the
	// top-level draft fields; a bare definition has `steps` or `summary`.
	hasDefinition := envelope["definition"] != nil
	hasStepsAtTop := envelope["steps"] != nil

	if hasDefinition {
		var d SkillDraft
		if err := json.Unmarshal([]byte(text), &d); err != nil {
			return nil, false
		}
		if err := skill.Validate(d.Definition); err != nil {
			return nil, false
		}
		// Fill optional defaults so the UI shows something usable.
		if d.Category == "" {
			d.Category = "general"
		}
		if d.RiskLevel == "" {
			d.RiskLevel = "low"
		}
		return &d, true
	}

	if hasStepsAtTop {
		// Whole document IS the definition.
		raw := json.RawMessage([]byte(text))
		if err := skill.Validate(raw); err != nil {
			return nil, false
		}
		// Try to pull a summary line for the auto-generated name.
		var partial struct {
			Summary string `json:"summary"`
		}
		_ = json.Unmarshal([]byte(text), &partial)
		return &SkillDraft{
			Key:        "",
			Name:       firstNonEmpty(partial.Summary, "Imported skill"),
			Category:   "general",
			RiskLevel:  "low",
			Definition: raw,
		}, true
	}

	return nil, false
}

// jsonFenceRE strips ```json ... ``` style markdown fences if the LLM uses them.
var jsonFenceRE = regexp.MustCompile("(?s)^[^{\\[]*?```(?:json)?\\s*(.*?)\\s*```[^}\\]]*?$")

// extractJSONObject grabs the first {...} or [...] block in the response.
// LLMs sometimes wrap output in prose like "Sure, here is the JSON: ...".
func extractJSONObject(s string) string {
	s = strings.TrimSpace(s)
	if m := jsonFenceRE.FindStringSubmatch(s); len(m) == 2 {
		return strings.TrimSpace(m[1])
	}
	// Find the first { ... matching } by depth-counting. Handles strings
	// containing { but stops at the outer-most closing brace.
	start := strings.IndexAny(s, "{[")
	if start < 0 {
		return s
	}
	depth := 0
	inStr := false
	esc := false
	for i := start; i < len(s); i++ {
		ch := s[i]
		if inStr {
			if esc {
				esc = false
			} else if ch == '\\' {
				esc = true
			} else if ch == '"' {
				inStr = false
			}
			continue
		}
		if ch == '"' {
			inStr = true
			continue
		}
		if ch == '{' || ch == '[' {
			depth++
		}
		if ch == '}' || ch == ']' {
			depth--
			if depth == 0 {
				return s[start : i+1]
			}
		}
	}
	return s
}

// buildSkillDraftPrompt assembles the system+user prompt for the AI conversion.
// The schema reference is kept compact — LLMs follow examples better than spec
// dumps. We also enumerate a curated subset of the most useful ops.
func buildSkillDraftPrompt(text, hintCategory, hintRisk string) string {
	hint := ""
	if hintCategory != "" {
		hint += fmt.Sprintf("\nUser hint — category: %s", hintCategory)
	}
	if hintRisk != "" {
		hint += fmt.Sprintf("\nUser hint — risk level: %s", hintRisk)
	}
	return fmt.Sprintf(`You convert operator-written SOPs (in any language) into a SeaweedFS
tiering-controller Skill definition. Reply with STRICT JSON only — no prose,
no markdown fences.

Schema (return exactly this shape):
{
  "key":        "<lowercase.dotted.identifier, e.g. custom.shrink_volume>",
  "name":       "<short human-readable name>",
  "category":   "<one of: tiering, ec, topology, maintenance, recovery, integrity, general>",
  "risk_level": "<one of: low, medium, high, critical>",
  "definition": {
    "summary":       "<one-sentence purpose>",
    "description":   "<optional 2-4 sentence detail, can be multi-line>",
    "params":        [{"name":"volume_id","type":"int","required":true}],
    "preconditions": [{"check":"volume_is_readonly","fatal":true}],
    "steps":         [{"id":"lock","op":"acquire_volume_lock","timeout_seconds":30}],
    "rollback":      [],
    "postchecks":    []
  }
}

Useful ops you can pick (each is a real backend handler):
- acquire_volume_lock, acquire_cluster_balance_lock, acquire_cluster_repair_lock
- tier_move_dat_to_remote, tier_move_dat_from_remote, verify_remote_tier
- ec_encode, ec_rebuild, ec_decode
- volume_balance, volume_shrink, volume_fix_replication, volume_delete_replica
- volume_vacuum, volume_fsck
- emit_failover_report, compute_failover_matrix, alert_if_at_risk
- audit_log (always include a final {id:"audit", op:"audit_log", args:{action:"..."}} step)
- shell_volume_vacuum (use sparingly, prefer typed ops above)

Useful precondition checks:
- volume_is_readonly, volume_serves_reads, cluster_healthy, cluster_reachable
- backend_reachable, in_change_window_or_emergency, replicas_present

Rules:
1. Always pick the safest reasonable risk level. If unsure, prefer "medium".
2. Always include a final audit_log step.
3. If the SOP is destructive, add a rollback array.
4. Use existing op names — don't invent new ones.
5. If the source SOP mentions a specific volume action, make the key follow
   the pattern "custom.<action>" so it doesn't collide with system skills.%s

Source SOP (operator-pasted, may be in Chinese or English):
"""
%s
"""

Return only the JSON object.`, hint, strings.TrimSpace(text))
}
