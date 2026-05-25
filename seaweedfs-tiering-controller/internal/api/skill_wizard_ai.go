package api

// Skill wizard AI helper. The existing /skills/draft-from-text takes a
// blob of prose and returns a whole skill. That's coarse — when the
// operator is halfway through the wizard with summary + params + a few
// steps already, they want help with ONE missing section, not a fresh
// generation that overwrites everything.
//
// This endpoint takes the current partial draft + a section name and
// returns AI suggestions ONLY for that section. The operator decides
// whether to accept; the wizard merges the section in-place.
//
// Sections supported:
//   "steps"         — []SkillStep   (the executor pipeline)
//   "rollback"      — []RollbackStep (inverse of destructive steps)
//   "postchecks"    — []Check       (verification after success)
//   "preconditions" — []Check       (gates before run)
//   "risk"          — {risk_level, rationale}
//
// Safety: every AI-suggested array is validated against the skill
// JSON-schema via a synthetic definition before returning. Bad ops or
// shape errors are rejected so the wizard never sees malformed steps.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/skill"
)

// wizardSuggestReq is what the wizard posts. draft can be partial —
// any missing field is treated as empty.
type wizardSuggestReq struct {
	Section      string          `json:"section"`
	Draft        json.RawMessage `json:"draft"`         // { meta, definition }
	ExtraContext string          `json:"extra_context"` // optional operator hint
}

type wizardDraft struct {
	Meta struct {
		Key       string `json:"key"`
		Name      string `json:"name"`
		Category  string `json:"category"`
		RiskLevel string `json:"risk_level"`
	} `json:"meta"`
	Definition skill.Definition `json:"definition"`
}

// wizardSuggestResp returns the suggestion + a short rationale. The
// shape of `suggestion` depends on section.
type wizardSuggestResp struct {
	OK           bool            `json:"ok"`
	Section      string          `json:"section"`
	Suggestion   json.RawMessage `json:"suggestion,omitempty"`
	Rationale    string          `json:"rationale,omitempty"`
	ProviderName string          `json:"provider_name,omitempty"`
	Error        string          `json:"error,omitempty"`
	Raw          string          `json:"raw,omitempty"`
}

var wizardSections = map[string]bool{
	"steps":         true,
	"rollback":      true,
	"postchecks":    true,
	"preconditions": true,
	"risk":          true,
}

// skillWizardSuggest handles POST /api/v1/skills/wizard-suggest.
func skillWizardSuggest(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body wizardSuggestReq
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		body.Section = strings.TrimSpace(body.Section)
		if !wizardSections[body.Section] {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": fmt.Sprintf("unsupported section %q; must be one of steps|rollback|postchecks|preconditions|risk", body.Section),
			})
			return
		}

		var dr wizardDraft
		if len(body.Draft) > 0 {
			if err := json.Unmarshal(body.Draft, &dr); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "bad draft: " + err.Error()})
				return
			}
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), 45*time.Second)
		defer cancel()

		provider, perr := resolveAssistantProvider(ctx, d)
		if perr != nil {
			c.JSON(http.StatusOK, wizardSuggestResp{Section: body.Section, Error: "AI provider not configured: " + perr.Error()})
			return
		}
		chatter, ok := provider.(jsonChatter)
		if !ok {
			c.JSON(http.StatusOK, wizardSuggestResp{Section: body.Section, Error: "Configured AI provider does not support JSON chat."})
			return
		}

		prompt := buildWizardSuggestPrompt(body.Section, &dr, body.ExtraContext)
		raw, aerr := chatter.JSONChat(ctx, prompt)
		if aerr != nil {
			c.JSON(http.StatusOK, wizardSuggestResp{Section: body.Section, Error: "AI call failed: " + aerr.Error()})
			return
		}
		cleaned := extractJSONObject(raw)

		suggestion, rationale, vErr := validateWizardSuggestion(body.Section, cleaned, &dr)
		if vErr != nil {
			c.JSON(http.StatusOK, wizardSuggestResp{
				Section: body.Section,
				Error:   "AI returned an invalid suggestion: " + vErr.Error(),
				Raw:     raw,
			})
			return
		}

		c.JSON(http.StatusOK, wizardSuggestResp{
			OK:           true,
			Section:      body.Section,
			Suggestion:   suggestion,
			Rationale:    rationale,
			ProviderName: provider.Name(),
		})
	}
}

// validateWizardSuggestion parses the AI's response object, extracts
// the section payload, and synthesises a minimal Definition around it
// so we can reuse skill.Validate. Returns the section payload + the
// rationale string, ready to ship to the frontend.
//
// AI is expected to return: { "<section>": <payload>, "rationale": "..." }
func validateWizardSuggestion(section, cleanedJSON string, dr *wizardDraft) (json.RawMessage, string, error) {
	var wrapper map[string]json.RawMessage
	if err := json.Unmarshal([]byte(cleanedJSON), &wrapper); err != nil {
		return nil, "", fmt.Errorf("not a JSON object: %w", err)
	}
	payload, ok := wrapper[section]
	if !ok || len(payload) == 0 {
		return nil, "", fmt.Errorf("missing %q key in response", section)
	}
	rationale := ""
	if r, ok := wrapper["rationale"]; ok {
		_ = json.Unmarshal(r, &rationale)
	}

	switch section {
	case "steps":
		// Wrap into a synthetic definition + validate. Need a summary
		// + steps to pass the schema; we use the existing summary if
		// any, otherwise a placeholder.
		summary := dr.Definition.Summary
		if summary == "" {
			summary = "validation placeholder"
		}
		synth := map[string]any{
			"summary": summary,
			"steps":   json.RawMessage(payload),
		}
		raw, _ := json.Marshal(synth)
		if err := skill.Validate(raw); err != nil {
			return nil, "", fmt.Errorf("steps: %w", err)
		}
	case "rollback":
		// Rollback alone isn't a valid definition; combine with the
		// operator's existing steps for validation. If the operator
		// has no steps yet, validate against a single audit_log step
		// so the schema is happy.
		stepsJSON, _ := json.Marshal(dr.Definition.Steps)
		if len(dr.Definition.Steps) == 0 {
			stepsJSON = []byte(`[{"op":"audit_log","args":{"action":"placeholder"}}]`)
		}
		synth := map[string]json.RawMessage{
			"summary":  []byte(`"validation placeholder"`),
			"steps":    stepsJSON,
			"rollback": payload,
		}
		raw, _ := json.Marshal(synth)
		if err := skill.Validate(raw); err != nil {
			return nil, "", fmt.Errorf("rollback: %w", err)
		}
	case "postchecks", "preconditions":
		stepsJSON, _ := json.Marshal(dr.Definition.Steps)
		if len(dr.Definition.Steps) == 0 {
			stepsJSON = []byte(`[{"op":"audit_log","args":{"action":"placeholder"}}]`)
		}
		synth := map[string]json.RawMessage{
			"summary": []byte(`"validation placeholder"`),
			"steps":   stepsJSON,
			section:   payload,
		}
		raw, _ := json.Marshal(synth)
		if err := skill.Validate(raw); err != nil {
			return nil, "", fmt.Errorf("%s: %w", section, err)
		}
	case "risk":
		// risk is a string, not an array — schema doesn't apply.
		// Just enforce one of the known values.
		var rv string
		if err := json.Unmarshal(payload, &rv); err != nil {
			return nil, "", fmt.Errorf("risk must be a string, got %s", string(payload))
		}
		switch rv {
		case "low", "medium", "high", "critical":
		default:
			return nil, "", fmt.Errorf("risk must be low|medium|high|critical, got %q", rv)
		}
	}
	return payload, rationale, nil
}

// buildWizardSuggestPrompt returns a section-specific prompt. We
// deliberately include the operator's current draft so the AI is
// completing what's there, not generating from scratch.
func buildWizardSuggestPrompt(section string, dr *wizardDraft, extra string) string {
	var b strings.Builder
	b.WriteString(`You are a SOP authoring assistant for a SeaweedFS tiering controller.
The operator is in the middle of editing a Skill (a versioned, schema-validated
operational procedure). They have asked you to fill in ONE section.

Return STRICT JSON of this shape:
`)
	switch section {
	case "steps":
		b.WriteString(`{
  "steps":     [ { "id": "...", "op": "<known_op>", "args": {...}, "on_failure": "abort|continue|rollback", "doc": "..." } ],
  "rationale": "1-3 sentences explaining the proposed flow"
}

RULES:
- Use only ops the controller knows: acquire_volume_lock, acquire_cluster_balance_lock,
  acquire_cluster_repair_lock, tier_move_dat_to_remote, tier_move_dat_from_remote,
  volume_balance, volume_fix_replication, volume_delete_replica, volume_ec_encode,
  volume_ec_decode, volume_vacuum, volume_fsck, collection_move, audit_log,
  http_get, http_post, sleep, set_flag, clear_flag, check_lock_held.
- Start with the relevant acquire_*_lock when concurrency matters.
- End with audit_log so /audit shows the run.
- Set on_failure=rollback ONLY on the destructive step that's covered by the
  rollback block (suggest the rollback separately).
- Use {volume_id}, {collection}, {master} placeholders in args when the value
  should come from operator inputs.
`)
	case "rollback":
		b.WriteString(`{
  "rollback":  [ { "op": "<known_op>", "args": {...}, "doc": "..." } ],
  "rationale": "1-3 sentences explaining how this undoes the destructive step"
}

RULES:
- Mirror the inverse of the destructive step in the operator's "steps".
- Use only ops in the catalogue (see steps section for the list).
- Skip ops that are themselves destructive — rollback should be safe to
  retry without making the situation worse.
- Empty array is acceptable if no destructive step exists in the draft.
`)
	case "postchecks":
		b.WriteString(`{
  "postchecks": [ { "check": "<check_name>", "args": {...}, "fatal": false, "doc": "..." } ],
  "rationale":  "1-3 sentences explaining what these verify"
}

RULES:
- Each item is a verification run AFTER steps succeed.
- Common check names: volume_exists, volume_status, replication_count,
  ec_shard_count, remote_object_exists, free_space_gte, audit_logged.
- Mark fatal=true ONLY when a check failure means the operation didn't
  really succeed and should be flagged for the operator.
`)
	case "preconditions":
		b.WriteString(`{
  "preconditions": [ { "check": "<check_name>", "args": {...}, "fatal": true, "doc": "..." } ],
  "rationale":     "1-3 sentences explaining what these guard against"
}

RULES:
- Each item is a gate run BEFORE the steps execute.
- Use the same check names as postchecks. fatal=true is the default —
  preconditions exist to abort before we touch anything.
- Common patterns: volume_exists + replication_count + free_space_gte
  before a tier move; ec_shard_count + lock_available before ec_decode.
`)
	case "risk":
		b.WriteString(`{
  "risk":      "low" | "medium" | "high" | "critical",
  "rationale": "1-3 sentences citing the destructive ops in the draft"
}

RULES:
- low      — read-only or trivially reversible (audit_log only).
- medium   — reversible writes (tier_move, vacuum, balance).
- high     — destructive but recoverable (delete_replica with replica_min, ec_decode).
- critical — irreversible or affecting many objects at once (collection-wide
             delete, mass identity changes).
- Be conservative — when in doubt pick the higher tier and say why.
`)
	}

	b.WriteString("\nCURRENT DRAFT:\n")
	b.WriteString("  key:         " + dr.Meta.Key + "\n")
	b.WriteString("  name:        " + dr.Meta.Name + "\n")
	b.WriteString("  category:    " + dr.Meta.Category + "\n")
	b.WriteString("  risk_level:  " + dr.Meta.RiskLevel + "\n")
	b.WriteString("  summary:     " + dr.Definition.Summary + "\n")
	if dr.Definition.Description != "" {
		b.WriteString("  description: " + dr.Definition.Description + "\n")
	}
	if len(dr.Definition.Params) > 0 {
		b.WriteString("  params:\n")
		for _, p := range dr.Definition.Params {
			fmt.Fprintf(&b, "    - %s (%s%s)\n", p.Name, p.Type,
				map[bool]string{true: ", required", false: ""}[p.Required])
		}
	}
	if len(dr.Definition.Preconditions) > 0 {
		b.WriteString("  preconditions:\n")
		for _, p := range dr.Definition.Preconditions {
			fmt.Fprintf(&b, "    - %s\n", p.Check)
		}
	}
	if len(dr.Definition.Steps) > 0 {
		b.WriteString("  steps (already drafted):\n")
		for i, s := range dr.Definition.Steps {
			fmt.Fprintf(&b, "    %d. op=%s id=%s on_failure=%s\n", i+1, s.Op, s.ID, s.OnFailure)
		}
	}
	if len(dr.Definition.Rollback) > 0 {
		b.WriteString("  rollback (already drafted):\n")
		for _, r := range dr.Definition.Rollback {
			fmt.Fprintf(&b, "    - op=%s\n", r.Op)
		}
	}
	if e := strings.TrimSpace(extra); e != "" {
		b.WriteString("\nOPERATOR HINT: " + e + "\n")
	}
	b.WriteString("\nReturn ONLY the JSON object. No prose before or after.\n")
	return b.String()
}
