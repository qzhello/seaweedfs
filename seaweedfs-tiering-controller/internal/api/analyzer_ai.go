package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/analyzer"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// optimizeAnalyzerScript asks the configured AI to refactor a script
// for clarity / correctness / robustness. The request includes:
//   - current body + params + sample input/output
//   - operator-supplied focus ("make it handle missing collection field",
//     "speed up by avoiding regex on every line", …)
//
// Response is a JSON envelope with the proposed new body and a short
// rationale. The handler does NOT persist — operators preview the
// diff, optionally run the sandbox, then click Save to commit, which
// creates a new version with reason="ai-optimize".
//
//	POST /analyzer/scripts/:id/optimize
//	body: { focus: "<freeform>", sample_input?: string }
//	resp: { ok: true, body, rationale, sandbox_result? }
//	      { ok: false, error }
func optimizeAnalyzerScript(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		s, err := d.PG.GetAnalyzerScript(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		var body struct {
			Focus       string `json:"focus,omitempty"`
			SampleInput string `json:"sample_input,omitempty"`
		}
		_ = c.BindJSON(&body)

		provider, perr := resolveAssistantProvider(c.Request.Context(), d)
		if perr != nil {
			c.JSON(http.StatusOK, gin.H{"ok": false, "error": perr.Error()})
			return
		}
		chatter, ok := provider.(jsonChatter)
		if !ok {
			c.JSON(http.StatusOK, gin.H{
				"ok":    false,
				"error": "Configured AI provider does not support JSON chat. Pick an OpenAI/Anthropic-compatible provider in /ai-config.",
			})
			return
		}
		prompt := buildAnalyzerOptimizePrompt(c.Request.Context(), s, body.Focus, body.SampleInput)
		raw, err := chatter.JSONChat(c.Request.Context(), prompt)
		if err != nil {
			c.JSON(http.StatusOK, gin.H{"ok": false, "error": "AI call failed: " + err.Error()})
			return
		}
		var parsed struct {
			Body      string `json:"body"`
			Rationale string `json:"rationale"`
		}
		if err := json.Unmarshal([]byte(extractJSONObject(raw)), &parsed); err != nil || strings.TrimSpace(parsed.Body) == "" {
			c.JSON(http.StatusOK, gin.H{
				"ok":    false,
				"error": "AI did not return a usable optimization. Try rephrasing the focus.",
				"raw":   raw,
			})
			return
		}

		// Smoke-test the proposed body against the fixture so the
		// operator gets a green/red signal without leaving the page.
		var sandbox *analyzer.Result
		input := body.SampleInput
		if input == "" {
			input = s.SampleInput
		}
		if input != "" {
			res, _ := analyzer.Run(c.Request.Context(), analyzer.Request{
				Body:  parsed.Body,
				Input: input,
			})
			sandbox = res
		}

		c.JSON(http.StatusOK, gin.H{
			"ok":             true,
			"body":           parsed.Body,
			"rationale":      parsed.Rationale,
			"sandbox_result": sandbox,
		})
	}
}

func buildAnalyzerOptimizePrompt(ctx context.Context, s *store.AnalyzerScript, focus, sampleOverride string) string {
	lang := "Write the `rationale` field in English."
	if IsZh(ctx) {
		lang = "用简体中文撰写 `rationale` 字段。`body` 必须保持英文 Python 源码。"
	}
	sample := sampleOverride
	if sample == "" {
		sample = s.SampleInput
	}
	if focus == "" {
		focus = "Improve clarity, error handling, and robustness against edge cases. Keep the public input/output contract identical."
	}
	return fmt.Sprintf(`You optimize Python analyzer scripts for a SeaweedFS ops platform.

Reply with ONLY a JSON object (no markdown, no prose):
{
  "body": "<the improved Python source>",
  "rationale": "<3-5 sentences explaining what changed and why>"
}

Language: %s

Hard contract every script MUST satisfy:
- Reads a single JSON object from stdin: {"input": "<raw text>", "params": {...}}
- Writes a single JSON object to stdout: {"ok": true, "result": <any>} or {"ok": false, "error": "..."}
- No filesystem writes. No network. No subprocess. No third-party imports — only Python stdlib.
- Must complete under 10 seconds and produce under 2 MB of output.
- The "result" shape must stay backward compatible with the current script's downstream consumers (templates may reference top-level keys via {{stepN.analyzer.<key>}}).

Script metadata:
  name:        %s
  title:       %s
  description: %s
  for_commands: %s
  tags: %s
  params: %s

Current body (you are editing THIS):
` + "```python\n%s\n```" + `

Sample input fixture (the kind of text it will receive on stdin's "input"):
` + "```\n%s\n```" + `

Operator focus for this optimization pass:
%s

Refactor the script to satisfy the focus while keeping the I/O contract. Prefer:
- Early returns over deep nesting.
- Comments explaining tricky regex / parser branches.
- Robust handling of empty / malformed input lines (skip with a comment, never raise).
- json.dumps(...) with default str fallback for any non-stringifiable values.

If the current script already satisfies the focus, return the SAME body with a rationale that says so.
`, lang, s.Name, s.Title, s.Description,
		strings.Join(s.ForCommands, ", "),
		strings.Join(s.Tags, ", "),
		strings.TrimSpace(string(s.Params)),
		s.Body, truncForPrompt(sample, 4000), focus)
}

func truncForPrompt(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "\n...(truncated for prompt)"
}
