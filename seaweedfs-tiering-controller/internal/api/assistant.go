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

const assistantSystemHeader = "You are a SeaweedFS tiering-controller operator assistant. " +
	"Strictly follow the SOPs below. If the operator's question falls outside them, " +
	"say so. Be concise. Default reply language: Chinese."

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

		if d.AI == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"error": "AI provider not configured. Configure one in /ai-config.",
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
		reply, err := d.AI.Chat(ctx, systemPrompt, convo)
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
func buildAssistantSystemPrompt(ctx context.Context, d Deps, clusterID *uuid.UUID, pagePath string) string {
	var b strings.Builder
	b.WriteString(assistantSystemHeader)
	b.WriteString("\n\n")

	// SOPs from skills table.
	skills, err := d.PG.ListSkills(ctx, "")
	if err == nil {
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
