package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// precheckTimeout caps the AI advisor call. Short enough that operators
// don't sit idle waiting on the model, long enough for a normal chat
// roundtrip. Advisory only — if we time out, the runner proceeds without
// advice rather than blocking the run.
const precheckTimeout = 10 * time.Second

// precheckAdvice is the advisor's reply. Every field is optional —
// the UI just hides whichever sections come back empty. We deliberately
// avoid any "ok/warn/block" verdict because the user wants this to be
// pure advice, not a decision.
type precheckAdvice struct {
	Risk     string `json:"risk,omitempty"`
	WatchOut string `json:"watch_out,omitempty"`
	Rollback string `json:"rollback,omitempty"`
}

// precheckRequest is the wire payload from the frontend approval card.
// We accept the final rendered command (with {{vars}} substituted)
// because that's what the operator is actually about to run — the
// model should reason about THAT, not a placeholder-laden template.
type precheckRequest struct {
	Command       string `json:"command"`
	RenderedArgs  string `json:"rendered_args"`
	Reason        string `json:"reason,omitempty"`
	TemplateGoal  string `json:"template_goal,omitempty"`
	PriorOutput   string `json:"prior_output,omitempty"`
}

// precheckOpsStep is invoked from the approval card, either automatically
// (when the template has ai_precheck=true) or manually (operator clicks
// "Ask AI"). Returns advisory text. Always 200 OK with whatever the
// model produced; transport errors degrade to {ok:false, error:...} so
// the frontend can show a discreet "advisor unavailable" hint without
// disrupting the run.
func precheckOpsStep(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body precheckRequest
		if err := c.BindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": err.Error()})
			return
		}
		if strings.TrimSpace(body.Command) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "command required"})
			return
		}
		// Gate on the catalog so a bogus command name doesn't get
		// sent to the model.
		allow := shellAllowedNames()
		if _, ok := allow[body.Command]; !ok {
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "unknown command"})
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), precheckTimeout)
		defer cancel()

		provider, err := resolveAssistantProvider(ctx, d)
		if err != nil {
			c.JSON(http.StatusOK, gin.H{"ok": false, "error": "AI provider unavailable"})
			return
		}
		chatter, ok := provider.(jsonChatter)
		if !ok {
			c.JSON(http.StatusOK, gin.H{"ok": false, "error": "AI provider can't do JSON chat"})
			return
		}
		prompt := buildPrecheckPrompt(c.Request.Context(), body)
		raw, err := chatter.JSONChat(ctx, prompt)
		if err != nil {
			c.JSON(http.StatusOK, gin.H{"ok": false, "error": err.Error()})
			return
		}
		cleaned := extractJSONObject(raw)
		var advice precheckAdvice
		if err := json.Unmarshal([]byte(cleaned), &advice); err != nil {
			c.JSON(http.StatusOK, gin.H{"ok": false, "error": "AI returned non-JSON", "raw": raw})
			return
		}
		// Trim — models sometimes pad with whitespace which renders as
		// awkward blank lines in the UI block.
		advice.Risk = strings.TrimSpace(advice.Risk)
		advice.WatchOut = strings.TrimSpace(advice.WatchOut)
		advice.Rollback = strings.TrimSpace(advice.Rollback)
		c.JSON(http.StatusOK, gin.H{"ok": true, "advice": advice})
	}
}

// buildPrecheckPrompt asks the model to comment on a single about-to-run
// mutating step. Three short fields, all optional — the UI hides what
// the model omits, so it's better to leave a field blank than to fill
// it with filler. Localised via IsZh(ctx).
func buildPrecheckPrompt(ctx context.Context, req precheckRequest) string {
	priorBlock := ""
	if strings.TrimSpace(req.PriorOutput) != "" {
		// Truncate prior output to keep the prompt small. The advisor
		// rarely needs more than the head/tail; full output blows up
		// token cost on chatty commands like volume.list.
		out := req.PriorOutput
		if len(out) > 4000 {
			out = out[:2000] + "\n... (truncated) ...\n" + out[len(out)-2000:]
		}
		priorBlock = fmt.Sprintf("\nPrior step output (for context):\n%s\n", out)
	}
	goal := strings.TrimSpace(req.TemplateGoal)
	if goal == "" {
		goal = "(not provided)"
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		reason = "(not provided)"
	}
	if IsZh(ctx) {
		return fmt.Sprintf(`你是 SeaweedFS 集群运维顾问。下面有一条**即将执行的高风险命令**,请用中文给出**简洁**的建议。

只回复 JSON,不要 markdown,不要前言后语。字段全部可选 —— 如果某项没有有用内容就**留空字符串**,不要硬凑废话。

JSON 结构:
{
  "risk": "这条命令会带来什么风险(一两句话)",
  "watch_out": "执行前要确认/注意什么(一两句话)",
  "rollback": "出问题如何回滚(一两句话,如果没有可靠回滚方案就留空)"
}

不要给"请确认是否真的需要执行"这类废话。要具体、可操作。

模板目标: %s
本步目的: %s
即将执行: %s %s%s`, goal, reason, req.Command, req.RenderedArgs, priorBlock)
	}
	return fmt.Sprintf(`You are a SeaweedFS operations advisor. A high-risk command is about to run. Give **terse** advice.

Reply with JSON only — no markdown, no preamble. Every field is optional; leave a field as "" if you have nothing concrete to say. Do not pad with filler like "make sure you really need to do this".

JSON shape:
{
  "risk": "What this command actually risks (1-2 sentences)",
  "watch_out": "What to verify before approving (1-2 sentences)",
  "rollback": "How to undo it if it goes wrong (1-2 sentences; leave empty if no reliable rollback exists)"
}

Template goal: %s
This step's reason: %s
About to run: %s %s%s`, goal, reason, req.Command, req.RenderedArgs, priorBlock)
}
