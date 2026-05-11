// Postmortem analyzes a failed execution: feeds the log + task context to
// the configured LLM, parses a structured verdict, and persists it so the
// UI can offer a one-click "apply AI suggestion" button.
//
// This is intentionally lighter than the multi-round pre-flight review:
// failures are diagnostic, not safety-critical. One round, JSON only.
package aireview

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"
)

// PostmortemVerdict mirrors what the prompt asks the LLM to output.
type PostmortemVerdict string

const (
	PostmortemTransientRetry  PostmortemVerdict = "transient_retry"
	PostmortemPermanentAbort  PostmortemVerdict = "permanent_abort"
	PostmortemNeedsHuman      PostmortemVerdict = "needs_human"
	PostmortemAdjustAndRetry  PostmortemVerdict = "adjust_and_retry"
)

func (v PostmortemVerdict) Valid() bool {
	switch v {
	case PostmortemTransientRetry, PostmortemPermanentAbort,
		PostmortemNeedsHuman, PostmortemAdjustAndRetry:
		return true
	}
	return false
}

// PostmortemResult is what gets persisted to executions.ai_postmortem and
// returned to the UI. Field names match the JSON schema in the migration.
type PostmortemResult struct {
	Verdict           PostmortemVerdict `json:"verdict"`
	Confidence        float64           `json:"confidence"`
	RootCause         string            `json:"root_cause"`
	RecommendedAction string            `json:"recommended_action"`
	RetrySafe         bool              `json:"retry_safe"`
	ProducedAt        time.Time         `json:"produced_at"`
	Provider          string            `json:"provider"`
}

// PostmortemInput is the trimmed context we send to the LLM. The full
// execution log can be huge — caller is expected to truncate it.
type PostmortemInput struct {
	TaskID     uuid.UUID
	ExecID     uuid.UUID
	VolumeID   uint32
	Action     string
	SkillKey   string
	Status     string // "failed" / "running" (when called manually mid-flight)
	Error      string // executions.error column
	Log        string // accumulated step log
	RetryCount int    // how many times this task has already been retried
}

// RunPostmortem runs a single AI round to diagnose the failure. Returns the
// parsed result plus the raw LLM response (saved on the execution row by
// the caller). Errors mean we couldn't even produce a verdict — the caller
// should fall back to needs_human.
func (s *Service) RunPostmortem(ctx context.Context, in PostmortemInput) (*PostmortemResult, error) {
	provider, _, providerName, err := s.pickProvider(ctx)
	if err != nil {
		return nil, fmt.Errorf("pick provider: %w", err)
	}
	lang := ""
	if s.pg != nil {
		if cfg, gErr := s.pg.GetConfig(ctx, "aireview.lang"); gErr == nil && cfg != nil {
			var v string
			if json.Unmarshal(cfg.Value, &v) == nil {
				lang = v
			}
		}
	}
	prompt := postmortemPrompt(in, lang)

	jr, ok := provider.(jsonChatter)
	var resp string
	if ok {
		resp, err = jr.JSONChat(ctx, prompt)
	} else {
		// Rule provider — no real diagnosis. Synthesize a conservative result
		// so the UI still has something to show.
		return &PostmortemResult{
			Verdict:           PostmortemNeedsHuman,
			Confidence:        0,
			RootCause:         "AI provider not available — rule fallback",
			RecommendedAction: "Configure an LLM provider in /ai-config and re-run postmortem",
			RetrySafe:         false,
			ProducedAt:        time.Now().UTC(),
			Provider:          providerName,
		}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("llm call: %w", err)
	}
	res, err := parsePostmortemResponse(resp)
	if err != nil {
		return nil, fmt.Errorf("parse: %w (raw: %s)", err, truncate(resp, 200))
	}
	res.ProducedAt = time.Now().UTC()
	res.Provider = providerName
	if s.log != nil {
		s.log.Info("postmortem produced",
			zap.String("exec", in.ExecID.String()),
			zap.String("verdict", string(res.Verdict)),
			zap.Float64("conf", res.Confidence))
	}
	return res, nil
}

func parsePostmortemResponse(s string) (*PostmortemResult, error) {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		s = strings.TrimPrefix(s, "```json")
		s = strings.TrimPrefix(s, "```")
		s = strings.TrimSuffix(s, "```")
		s = strings.TrimSpace(s)
	}
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start < 0 || end <= start {
		return nil, fmt.Errorf("no JSON object")
	}
	s = s[start : end+1]

	var raw struct {
		Verdict           string  `json:"verdict"`
		Confidence        float64 `json:"confidence"`
		RootCause         string  `json:"root_cause"`
		RecommendedAction string  `json:"recommended_action"`
		RetrySafe         bool    `json:"retry_safe"`
	}
	if err := json.Unmarshal([]byte(s), &raw); err != nil {
		return nil, err
	}
	verdict := PostmortemVerdict(strings.ToLower(strings.TrimSpace(raw.Verdict)))
	if !verdict.Valid() {
		return nil, fmt.Errorf("invalid verdict %q", raw.Verdict)
	}
	if raw.Confidence < 0 {
		raw.Confidence = 0
	} else if raw.Confidence > 1 {
		raw.Confidence = 1
	}
	return &PostmortemResult{
		Verdict:           verdict,
		Confidence:        raw.Confidence,
		RootCause:         truncate(raw.RootCause, 300),
		RecommendedAction: truncate(raw.RecommendedAction, 300),
		RetrySafe:         raw.RetrySafe,
	}, nil
}

func postmortemPrompt(in PostmortemInput, lang string) string {
	header := `You are diagnosing a failed SeaweedFS tiering operation. Reply with strict JSON only — no prose. Schema:
{"verdict":"transient_retry|permanent_abort|needs_human|adjust_and_retry","confidence":0..1,"root_cause":"<=300 chars","recommended_action":"<=300 chars","retry_safe":true|false}

Decision rubric:
- transient_retry  : network blip / lock contention / temporary master unavailable / single-step timeout. Same task, no changes.
- adjust_and_retry : task params likely too aggressive (concurrency, batch size, scope). Recommend narrower scope.
- permanent_abort  : data already in target state, or pre-condition impossible (e.g. volume removed). Don't retry.
- needs_human      : ambiguous / data-integrity risk / unfamiliar error. Operator must inspect.

retry_safe is TRUE only if the operation is idempotent at this point in the log. Be conservative.`
	header += langDirective(lang)

	logExcerpt := truncateTail(in.Log, 4000)
	errExcerpt := truncateTail(in.Error, 500)

	return fmt.Sprintf(`%s

Task:    id=%s volume=%d action=%s skill=%s
Status:  %s   retry_count=%d
Error:   %s
Execution log (truncated, last 4KB):
---
%s
---

Reply only with the JSON object.`,
		header, in.TaskID, in.VolumeID, in.Action, in.SkillKey, in.Status, in.RetryCount, errExcerpt, logExcerpt)
}

// truncateTail keeps the last n chars — postmortem cares about the tail of
// a log, since errors usually surface there. Distinct from the head-biased
// truncate() in orchestrator.go.
func truncateTail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return "...[truncated]...\n" + s[len(s)-n+20:]
}
