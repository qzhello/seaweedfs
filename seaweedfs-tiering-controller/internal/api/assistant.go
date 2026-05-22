package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/ai"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/auth"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

const (
	assistantHistoryKeep = 50
	assistantChatTimeout = 60 * time.Second
)

// assistantSystemHeader pins the assistant's behaviour. Two non-obvious
// rules are critical:
//
//  1. NO TOOL EXECUTION. The assistant has chat-completion access only —
//     there is no function calling / agentic loop wired up. Earlier
//     prompts caused the LLM to role-play running `cluster.failover_check`,
//     `volume.balance` etc., promise async results, and then nothing
//     would happen because no backend action was actually triggered.
//     We now forbid pretending and require the model to instead point
//     the operator at the concrete UI page or shell command.
//
//  2. NO FAKE PROGRESS. The model must not write phrases like
//     "正在执行…", "请稍候,完成后我会汇报结果", or "预计耗时 N 分钟" —
//     they create the false impression that something is running in
//     the background. The transport is a single request/response.
const assistantSystemHeader = "You are a SeaweedFS tiering-controller operator assistant. " +
	"Follow the SOPs below; if the operator's question falls outside them, say so. " +
	"Be concise. Default reply language: Chinese. " +
	"\n\nEXECUTION MODEL — read carefully:\n" +
	"  • You cannot run shell commands yourself and there is no follow-up " +
	"message. NEVER say '正在执行…', '正在为集群 X 执行 Y', " +
	"'请稍候,完成后我会汇报结果', '预计耗时 N 分钟', 'I'll run that for you', " +
	"or anything that implies an async job is already in flight.\n" +
	"  • Only the tools actually present in your tool list exist. NEVER " +
	"invent or call a tool by a name you were not given — a fabricated " +
	"tool call just fails.\n" +
	"  • When the operator should run an operational SOP: if your tool " +
	"list includes a tool for queueing an SOP as a pending task, call it. " +
	"It queues the SOP for the operator to approve — then tell them you " +
	"have queued it and they must approve it to run.\n" +
	"  • Otherwise (no such tool in your list, or it is not a runnable " +
	"SOP), tell the operator (a) which page in this UI to open, (b) which " +
	"command/button to use, and (c) what to check afterwards. Be specific.\n" +
	"  • When the operator asks 'what is happening', explain based on the " +
	"context below; do not invent results.\n" +
	"\n" +
	"SKILL/SOP USAGE:\n" +
	"  • The section '## Skill index (all enabled SOPs)' below lists every " +
	"SOP available on this platform. Treat this as the authoritative menu " +
	"of operations the operator can perform — do not invent SOPs not on this list.\n" +
	"  • A few of those SOPs are loaded in full ('## SOP: <key> - <name>'). " +
	"When the loaded body is sufficient, walk the operator through its steps.\n" +
	"  • If the relevant SOP appears in the index but is NOT loaded in full, " +
	"say so by key and suggest the operator open /skills/<key> for full text, " +
	"or describe what you remember from the summary while flagging the limit.\n" +
	"  • If no SOP matches, say so plainly. Do not fabricate procedures."

// principalUserID extracts the authenticated user's UUID. Returns uuid.Nil if
// the principal is missing or its UserID is not a valid UUID (e.g. anonymous
// dev shortcut).
func principalUserID(c *gin.Context) (uuid.UUID, bool) {
	p, ok := auth.Of(c)
	if !ok {
		return uuid.Nil, false
	}
	id, err := uuid.Parse(p.UserID)
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}

// listAssistantChats returns the calling user's chat threads.
func listAssistantChats(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := principalUserID(c)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthenticated"})
			return
		}
		items, err := d.PG.ListAssistantChats(c.Request.Context(), uid)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": items})
	}
}

// createAssistantChat creates a new (possibly untitled) chat.
func createAssistantChat(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := principalUserID(c)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthenticated"})
			return
		}
		var body struct {
			Title string `json:"title"`
		}
		_ = c.ShouldBindJSON(&body)
		chat, err := d.PG.CreateAssistantChat(c.Request.Context(), uid, body.Title)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, chat)
	}
}

// deleteAssistantChat removes a chat the caller owns.
func deleteAssistantChat(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := principalUserID(c)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthenticated"})
			return
		}
		chatID, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid chat id"})
			return
		}
		if err := d.PG.DeleteAssistantChat(c.Request.Context(), uid, chatID); err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// renameAssistantChat updates the title of a chat the caller owns.
func renameAssistantChat(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := principalUserID(c)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthenticated"})
			return
		}
		chatID, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid chat id"})
			return
		}
		var body struct {
			Title string `json:"title"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if err := d.PG.RenameAssistantChat(c.Request.Context(), uid, chatID, body.Title); err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// listAssistantMessages returns up to 50 messages for an owned chat.
func listAssistantMessages(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := principalUserID(c)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthenticated"})
			return
		}
		chatID, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid chat id"})
			return
		}
		if _, err := d.PG.GetAssistantChat(c.Request.Context(), uid, chatID); err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "chat not found"})
			return
		}
		items, err := d.PG.ListAssistantMessages(c.Request.Context(), chatID, assistantHistoryKeep)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": items})
	}
}

// postAssistantMessage records the operator's question, builds a SOP-grounded
// system prompt, calls the AI provider, persists the assistant reply, and
// trims the history. Returns both turns so the UI can render in one round-trip.
func postAssistantMessage(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := principalUserID(c)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthenticated"})
			return
		}
		chatID, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid chat id"})
			return
		}
		var body struct {
			Message   string `json:"message"`
			ClusterID string `json:"cluster_id"`
			PagePath  string `json:"page_path"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		msg := strings.TrimSpace(body.Message)
		if msg == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "message is required"})
			return
		}

		chat, err := d.PG.GetAssistantChat(c.Request.Context(), uid, chatID)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "chat not found"})
			return
		}

		var clusterPtr *uuid.UUID
		if body.ClusterID != "" {
			if cid, err := uuid.Parse(body.ClusterID); err == nil {
				clusterPtr = &cid
			}
		}

		// Persist the user turn before we call the provider so the message is
		// not lost if the provider fails.
		userMsg, err := d.PG.AppendAssistantMessage(c.Request.Context(), chat.ID,
			"user", msg, clusterPtr, body.PagePath)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		// Resolve the AI provider for this call. Prefer the operator-managed
		// default in ai_providers (configured via /ai-config); fall back to
		// the static-config provider (d.AI) only when no DB row exists. This
		// matters because d.AI is fixed at process start and ignores changes
		// made through the UI.
		chatProvider, provErr := resolveAssistantProvider(c.Request.Context(), d)
		if provErr != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"error": provErr.Error(),
				"user":  userMsg,
			})
			return
		}

		// Build the system prompt from the static header + matching SOPs +
		// optional current-cluster context.
		systemPrompt := buildAssistantSystemPrompt(c.Request.Context(), d, clusterPtr, body.PagePath)

		// Load previous history (oldest first), excluding the message we just
		// inserted, and append it as the new user turn.
		history, err := d.PG.ListAssistantMessages(c.Request.Context(), chat.ID, assistantHistoryKeep)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		convo := make([]ai.ChatMessage, 0, len(history))
		for _, m := range history {
			convo = append(convo, ai.ChatMessage{Role: m.Role, Content: m.Content})
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), assistantChatTimeout)
		defer cancel()
		reply, err := chatProvider.Chat(ctx, systemPrompt, convo)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{
				"error": fmt.Sprintf("ai chat failed: %v", err),
				"user":  userMsg,
			})
			return
		}

		assistantMsg, err := d.PG.AppendAssistantMessage(c.Request.Context(), chat.ID,
			"assistant", reply, clusterPtr, body.PagePath)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "user": userMsg})
			return
		}

		// Trim to most recent N and touch updated_at.
		if err := d.PG.TrimAssistantHistory(c.Request.Context(), chat.ID, assistantHistoryKeep); err != nil {
			d.Log.Sugar().Warnw("trim assistant history", "err", err, "chat", chat.ID)
		}

		// Backfill title from the first user message if the chat was created
		// untitled.
		if chat.Title == "" {
			t := msg
			if len(t) > 60 {
				t = t[:60]
			}
			if err := d.PG.RenameAssistantChat(c.Request.Context(), uid, chat.ID, t); err != nil {
				d.Log.Sugar().Warnw("backfill chat title", "err", err, "chat", chat.ID)
			}
		}

		c.JSON(http.StatusOK, gin.H{
			"user":      userMsg,
			"assistant": assistantMsg,
		})
	}
}

// buildAssistantSystemPrompt assembles header + matched SOPs + cluster block.
// Errors are non-fatal: we degrade to the header alone rather than break the
// chat path.
// resolveAssistantProvider returns the provider the floating assistant should
// use for this request. Order of preference:
//
//  1. The DB-managed default in ai_providers (configured via /ai-config).
//     Operators expect changes there to take effect without restart.
//  2. The static-config provider wired at process start (d.AI). Useful for
//     tests / dev where the DB has no rows yet.
//
// Returns an error only when neither source yields a usable, non-rule
// provider — at that point the assistant truly has nothing to talk to.
func resolveAssistantProvider(ctx context.Context, d Deps) (ai.Provider, error) {
	if d.PG != nil && d.AIResolver != nil {
		row, err := d.PG.GetDefaultAIProvider(ctx)
		if err == nil && row != nil {
			p, berr := d.AIResolver.Build(row)
			if berr == nil && p != nil && p.Name() != "rule" {
				return p, nil
			}
			// If the configured default is the rule provider, fall through —
			// that's effectively "no AI", and the user wants a real model.
		}
	}
	if d.AI != nil && d.AI.Name() != "rule" {
		return d.AI, nil
	}
	return nil, fmt.Errorf("AI provider not configured. Add and mark a provider as default in /ai-config.")
}

func buildAssistantSystemPrompt(ctx context.Context, d Deps, clusterID *uuid.UUID, pagePath string) string {
	var b strings.Builder
	b.WriteString(assistantSystemHeader)
	b.WriteString("\n\n")
	// Honor the operator's UI locale. The assistant talks to the
	// operator directly so its replies should match what they're
	// reading on screen, not whatever the model defaults to.
	if IsZh(ctx) {
		b.WriteString("## Reply language\n")
		b.WriteString("操作员当前使用简体中文界面。除非操作员明确切换语言或在引用命令/日志等不应翻译的内容,否则你的回复全部使用简体中文。命令名、文件路径、配置 key、错误码等保持英文原样。\n\n")
	} else {
		b.WriteString("## Reply language\n")
		b.WriteString("The operator is using the English UI. Reply in English unless they switch languages or are quoting non-English content.\n\n")
	}

	// Pull SOPs once. Used twice below: an index of ALL enabled
	// skills (so the LLM knows what exists and can name them), and
	// the full body of the top-N matches (so the most-likely-needed
	// SOP is already loaded without a second turn).
	skills, err := d.PG.ListSkills(ctx, "")
	if err == nil {
		// 1) Full index — one line per enabled skill. Format:
		//    - <key> [<category> / <risk>] — <summary>
		// Operators ask things like "我们有什么处理 EC 缺片的 SOP",
		// and the model needs to be able to answer from this index
		// without us hand-picking SOPs upfront.
		enabledIndex := make([]store.Skill, 0, len(skills))
		seenKey := map[string]struct{}{}
		for _, s := range skills {
			if !s.Enabled {
				continue
			}
			if _, ok := seenKey[s.Key]; ok {
				continue // ListSkills returns version DESC; keep newest
			}
			seenKey[s.Key] = struct{}{}
			enabledIndex = append(enabledIndex, s)
		}
		if len(enabledIndex) > 0 {
			b.WriteString("## Skill index (all enabled SOPs)\n")
			b.WriteString("The operator manages these in /skills. Reference them by key.\n")
			b.WriteString("If a relevant SOP isn't loaded in full below, tell the operator the key ")
			b.WriteString("and suggest opening /skills/<key> for full detail.\n\n")
			for _, s := range enabledIndex {
				summary := skillSummaryText(s.Definition)
				if summary == "" {
					summary = "(no summary)"
				}
				risk := s.RiskLevel
				if risk == "" {
					risk = "?"
				}
				cat := s.Category
				if cat == "" {
					cat = "general"
				}
				b.WriteString(fmt.Sprintf("- %s [%s / risk:%s] — %s\n", s.Key, cat, risk, summary))
			}
			b.WriteString("\n")
		}

		// 2) Full body of the top-N matched by the page-path heuristic.
		// We keep this small (3) so the prompt budget isn't blown out
		// by every visit to /clusters; the index above covers the
		// long tail.
		matched := pickTopSkills(skills, pagePath, 3)
		for _, s := range matched {
			body := skillBodyText(s.Definition)
			b.WriteString(fmt.Sprintf("## SOP: %s - %s\n%s\n\n", s.Key, s.Name, body))
		}
	}

	// Optional current cluster context (lightweight; no gRPC fanout).
	if clusterID != nil {
		if cl, err := d.PG.GetCluster(ctx, *clusterID); err == nil && cl != nil {
			b.WriteString("## Current cluster\n")
			b.WriteString(fmt.Sprintf("- name: %s\n", cl.Name))
			b.WriteString(fmt.Sprintf("- business_domain: %s\n", cl.BusinessDomain))
			b.WriteString(fmt.Sprintf("- master_addr: %s\n\n", cl.MasterAddr))
		}
	}

	return strings.TrimRight(b.String(), "\n")
}

// skillSummaryText extracts `definition->>'summary'` for the index.
// Falls back to an empty string when the field is missing or malformed.
func skillSummaryText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return ""
	}
	if s, ok := obj["summary"]; ok {
		var v string
		if err := json.Unmarshal(s, &v); err == nil {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// pickTopSkills returns the top N enabled skills, preferring skills whose
// category matches the page-derived heuristic. If no skills match the
// heuristic, falls back to the first N enabled skills sorted by category.
//
// Page-path → category heuristic: take the last two non-empty segments,
// trim a trailing "s" on the first segment (so "/volumes/balance" →
// "volume.balance" and "/clusters/check-disk" → "cluster.check-disk").
func pickTopSkills(skills []store.Skill, pagePath string, n int) []store.Skill {
	enabled := make([]store.Skill, 0, len(skills))
	seen := map[string]struct{}{}
	for _, s := range skills {
		if !s.Enabled {
			continue
		}
		if _, ok := seen[s.Key]; ok {
			continue
		}
		seen[s.Key] = struct{}{}
		enabled = append(enabled, s)
	}

	heuristic := categoryFromPagePath(pagePath)
	if heuristic != "" {
		matches := []store.Skill{}
		for _, s := range enabled {
			if s.Category == heuristic || strings.HasPrefix(s.Category, heuristic) {
				matches = append(matches, s)
				if len(matches) >= n {
					return matches
				}
			}
		}
		if len(matches) > 0 {
			return matches
		}
	}
	if len(enabled) > n {
		return enabled[:n]
	}
	return enabled
}

func categoryFromPagePath(p string) string {
	segs := []string{}
	for _, s := range strings.Split(p, "/") {
		s = strings.TrimSpace(s)
		if s != "" {
			segs = append(segs, s)
		}
	}
	if len(segs) < 2 {
		return ""
	}
	first := segs[len(segs)-2]
	second := segs[len(segs)-1]
	first = strings.TrimSuffix(first, "s")
	return first + "." + second
}

// skillBodyText reads `definition->>'body'` when present; otherwise returns the
// raw JSON string as a fallback. Best-effort — never panics on garbage.
func skillBodyText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err == nil {
		if body, ok := obj["body"]; ok {
			var s string
			if err := json.Unmarshal(body, &s); err == nil {
				return s
			}
			return string(body)
		}
	}
	return string(raw)
}
