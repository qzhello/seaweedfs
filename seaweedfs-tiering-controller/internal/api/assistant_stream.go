package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/ai"
)

// transcriptItem is one row of the JSON-encoded play-by-play we
// persist on each assistant message that involved tool calls. The
// frontend uses this shape to reconstruct inline tool bubbles when an
// old chat is reopened. Fields mirror the SSE event payloads
// 1:1 so the client renders the live and persisted views with the
// same component.
type transcriptItem struct {
	CallID    string `json:"call_id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
	Content   string `json:"content"`
	IsError   bool   `json:"is_error,omitempty"`
}

const (
	// streamMaxToolRounds caps the agentic loop. The model gets to
	// call tools, see results, call more, etc. — but only up to this
	// many rounds before we force a final answer. Stops runaway
	// loops where a model keeps re-calling the same tool with
	// different args.
	streamMaxToolRounds = 5
	// streamOverallTimeout is the wall-clock budget for one user
	// message including all tool rounds. Generous because a tool
	// fanout (e.g. list_volumes on a big cluster) can shell out.
	streamOverallTimeout = 4 * time.Minute
)

// postAssistantMessageStream is the SSE-streaming variant of
// postAssistantMessage. The transport differs (text/event-stream
// instead of a single JSON response) and the model is given a tool
// catalogue so it can self-serve cluster data. Persistence and
// system-prompt construction are reused.
//
// Wire format (one event per line, blank line separator):
//
//	event: user_msg            { id, content, ... }
//	event: token               { text }                    ← may repeat
//	event: tool_call           { id, name, arguments }     ← may repeat
//	event: tool_result         { call_id, content, error } ← matches above
//	event: assistant_msg       { id, content, ... }
//	event: done                { reason }
//	event: error               { message }
//
// Order: a single user message round emits one user_msg, zero or more
// (token | tool_call/tool_result) interleaved, one assistant_msg with
// the final text, and a done. error replaces done on failure.
func postAssistantMessageStream(d Deps) gin.HandlerFunc {
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

		provider, provErr := resolveAssistantProvider(c.Request.Context(), d)
		if provErr != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": provErr.Error()})
			return
		}
		streamer, ok := provider.(ai.StreamingProvider)
		if !ok {
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"error": "configured AI provider does not support streaming; pick an OpenAI-compatible one in /ai-config",
			})
			return
		}

		// Persist the user turn so it survives mid-stream
		// disconnects.
		userMsg, err := d.PG.AppendAssistantMessage(c.Request.Context(), chat.ID,
			"user", msg, clusterPtr, body.PagePath)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		systemPrompt := buildAssistantSystemPrompt(c.Request.Context(), d, clusterPtr, body.PagePath)
		history, err := d.PG.ListAssistantMessages(c.Request.Context(), chat.ID, assistantHistoryKeep)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		convo := make([]ai.ChatMessage, 0, len(history))
		for _, m := range history {
			convo = append(convo, ai.ChatMessage{Role: m.Role, Content: m.Content})
		}

		// Switch to SSE mode. Once we write the headers we can't
		// switch to JSON on error — every failure has to go through
		// the `error` event.
		c.Writer.Header().Set("Content-Type", "text/event-stream")
		c.Writer.Header().Set("Cache-Control", "no-cache, no-transform")
		c.Writer.Header().Set("Connection", "keep-alive")
		c.Writer.Header().Set("X-Accel-Buffering", "no") // nginx: stop buffering
		c.Writer.WriteHeader(http.StatusOK)
		flusher, _ := c.Writer.(http.Flusher)

		send := func(event string, payload any) {
			data, _ := json.Marshal(payload)
			fmt.Fprintf(c.Writer, "event: %s\ndata: %s\n\n", event, data)
			if flusher != nil {
				flusher.Flush()
			}
		}
		sendError := func(msg string) {
			send("error", map[string]string{"message": msg})
		}

		send("user_msg", userMsg)

		ctx, cancel := context.WithTimeout(c.Request.Context(), streamOverallTimeout)
		defer cancel()

		tools := assistantToolRegistry()
		// Filter tools by ai_tool_policies before exposing to the
		// LLM. Tools where ai_allowed=FALSE never appear in the
		// model's toolspec, so it physically cannot choose them —
		// this is the AI authorization gate the user asked for.
		// Failure to read the table degrades to "no tools" rather
		// than "all tools": fail-closed is safer for a write-capable
		// catalogue.
		allowed, allowErr := d.PG.GetAllowedAITools(ctx)
		if allowErr != nil {
			d.Log.Sugar().Warnw("read ai_tool_policies", "err", allowErr)
			allowed = map[string]struct{}{}
		}
		toolSpecs := make([]ai.ToolSpec, 0, len(tools))
		toolIndex := map[string]assistantTool{}
		for _, t := range tools {
			toolIndex[t.Spec.Name] = t
			if _, ok := allowed[t.Spec.Name]; ok {
				toolSpecs = append(toolSpecs, t.Spec)
			}
		}

		// Build the actor identity that travels with every tool
		// execution. Audit entries created by tool executors will
		// carry "ai:<chat-id>" so postmortems trace each write back
		// to the originating chat thread.
		actor := Actor{
			Kind:     "ai",
			Email:    "", // no human pressed the button; the LLM did
			Provider: provider.Name(),
			ChatID:   chat.ID.String(),
		}
		ctx = WithActor(ctx, actor)

		// Accumulators for the chat-message metadata we persist when
		// the stream completes. Each assistantTranscriptItem matches
		// one round of tool-call → tool-result so the UI can replay
		// the same bubbles when the user reopens the chat later.
		transcript := []transcriptItem{}

		// Agentic loop: stream → collect tool calls → execute → feed
		// results back → repeat until done or maxRounds.
		//
		// loopTurns accumulates, in the exact order OpenAI requires,
		// every assistant turn this request produced AND the tool-role
		// turns answering its tool_calls. It must carry ALL rounds: an
		// assistant turn with tool_calls is only valid when the matching
		// tool turns follow it, so a round-1 tool result cannot be
		// dropped once round 2 runs. (The old code reset the results
		// each round → round 1's tool_calls went unanswered → 400.)
		var finalText strings.Builder
		loopTurns := []ai.ChatMessage{}
		for round := 0; round < streamMaxToolRounds; round++ {
			ch, err := streamer.ChatStream(ctx, systemPrompt,
				appendAll(convo, loopTurns), toolSpecs, nil)
			if err != nil {
				sendError(err.Error())
				return
			}

			roundTokens := strings.Builder{}
			roundCalls := []ai.ToolCall{}
			finishReason := ""
		readLoop:
			for ev := range ch {
				switch ev.Kind {
				case "token":
					roundTokens.WriteString(ev.Token)
					finalText.WriteString(ev.Token)
					send("token", map[string]string{"text": ev.Token})
				case "tool_call":
					if ev.ToolCall != nil {
						roundCalls = append(roundCalls, *ev.ToolCall)
						send("tool_call", ev.ToolCall)
					}
				case "done":
					finishReason = ev.FinishReason
					break readLoop
				case "error":
					sendError(ev.Error)
					return
				}
			}

			// The assistant turn for this round.
			loopTurns = append(loopTurns, ai.ChatMessage{
				Role: "assistant", Content: roundTokens.String(), ToolCalls: roundCalls,
			})

			// No tool calls → final answer ready.
			if len(roundCalls) == 0 || finishReason == "stop" {
				break
			}

			// Execute each tool call, emit a tool_result event, and
			// append a tool-role turn directly after the assistant turn
			// so the message order stays valid for every later round.
			// Also append to `transcript` for the persisted play-by-play.
			for _, tc := range roundCalls {
				content, isErr := executeAssistantTool(ctx, d, toolIndex, allowed, tc)
				send("tool_result", map[string]any{
					"call_id": tc.ID, "is_error": isErr, "content": content,
				})
				loopTurns = append(loopTurns, ai.ChatMessage{
					Role: "tool", ToolCallID: tc.ID, Content: content,
				})
				transcript = append(transcript, transcriptItem{
					CallID:    tc.ID,
					Name:      tc.Name,
					Arguments: string(tc.Arguments),
					Content:   content,
					IsError:   isErr,
				})
			}
			// Loop again — the model now sees the tool outputs.
		}

		// Persist the final assistant message together with the
		// tool transcript (JSONB) so re-opening the chat shows the
		// same play-by-play. Nil transcript for pure-text turns
		// keeps the column empty.
		var transcriptJSON json.RawMessage
		if len(transcript) > 0 {
			if buf, err := json.Marshal(transcript); err == nil {
				transcriptJSON = buf
			}
		}
		assistantMsg, err := d.PG.AppendAssistantMessageWithTranscript(c.Request.Context(), chat.ID,
			"assistant", finalText.String(), clusterPtr, body.PagePath, transcriptJSON)
		if err != nil {
			sendError("persist assistant message: " + err.Error())
			return
		}
		send("assistant_msg", assistantMsg)

		if err := d.PG.TrimAssistantHistory(c.Request.Context(), chat.ID, assistantHistoryKeep); err != nil {
			d.Log.Sugar().Warnw("trim assistant history", "err", err, "chat", chat.ID)
		}
		if chat.Title == "" {
			t := msg
			if len(t) > 60 {
				t = t[:60]
			}
			_ = d.PG.RenameAssistantChat(c.Request.Context(), uid, chat.ID, t)
		}
		send("done", map[string]string{"reason": "ok"})
	}
}

// appendAll concatenates two slices into a fresh one so the caller's
// view isn't mutated when the next loop iteration appends more turns.
func appendAll(a []ai.ChatMessage, b []ai.ChatMessage) []ai.ChatMessage {
	out := make([]ai.ChatMessage, 0, len(a)+len(b))
	out = append(out, a...)
	out = append(out, b...)
	return out
}

// executeAssistantTool runs one tool call and returns its result as a
// JSON string plus whether it failed. Unknown / unauthorized tools and
// executor errors all return a JSON {"error":...} body rather than
// nothing — a tool_call left without a matching tool turn makes the next
// OpenAI request 400 ("insufficient tool messages following tool_calls").
func executeAssistantTool(
	ctx context.Context,
	d Deps,
	toolIndex map[string]assistantTool,
	allowed map[string]struct{},
	tc ai.ToolCall,
) (string, bool) {
	jsonErr := func(msg string) string {
		b, _ := json.Marshal(map[string]string{"error": msg})
		return string(b)
	}
	t, known := toolIndex[tc.Name]
	if !known {
		return jsonErr("unknown tool: " + tc.Name), true
	}
	// Defence in depth: the toolspec filter already hides unauthorized
	// tools, but a misbehaving model could fabricate a known name.
	if _, ok := allowed[tc.Name]; !ok {
		return jsonErr(fmt.Sprintf("tool %q is not authorized for the AI assistant. "+
			"Operator must enable it in /ai-config/tools.", tc.Name)), true
	}
	out, err := t.Execute(ctx, d, tc.Arguments)
	if err != nil {
		return jsonErr(err.Error()), true
	}
	b, mErr := json.Marshal(out)
	if mErr != nil {
		return jsonErr("marshal result: " + mErr.Error()), false
	}
	return string(b), false
}

// ensureWriterFlushed is a defensive no-op when the gin writer doesn't
// implement http.Flusher. Kept separate so future middleware that
// wraps the writer doesn't silently break streaming.
func ensureWriterFlushed(w io.Writer) {
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}
