package ai

import (
	"context"
	"encoding/json"
)

// ToolSpec describes one tool the LLM can choose to call. Mirrors the
// OpenAI function-calling shape (the de-facto standard most vendors
// implement, including Anthropic via tool_use, OpenRouter, Mistral,
// and most self-hosted gateways).
type ToolSpec struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	// Schema is a JSON Schema describing the tool's parameters.
	// Marshalled into the provider-specific shape at call time.
	Schema json.RawMessage `json:"schema"`
}

// ToolCall is one tool invocation produced by the LLM. ID is the
// provider-assigned correlation id so the same call's result can be
// echoed back in the next round.
type ToolCall struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

// ToolResult carries the executor's output for one ToolCall, keyed by
// the original call ID. Content is a JSON-encoded string so providers
// that demand stringified content (OpenAI) get it directly.
type ToolResult struct {
	CallID  string `json:"call_id"`
	Content string `json:"content"`
	IsError bool   `json:"is_error,omitempty"`
}

// StreamEvent is one delta emitted by a streaming chat call. Exactly
// one of the fields is populated per event. We deliberately use a
// flat tagged union (Kind + per-kind field) instead of a Go interface
// so SSE encoders can JSON-marshal events without reflection.
type StreamEvent struct {
	Kind string `json:"kind"` // "token" | "tool_call" | "done" | "error"
	// Token is a partial-text chunk (Kind == "token").
	Token string `json:"token,omitempty"`
	// ToolCall is a full call ready to execute (Kind == "tool_call").
	// We accumulate provider deltas internally and only emit once the
	// arguments are complete JSON — the executor never sees partials.
	ToolCall *ToolCall `json:"tool_call,omitempty"`
	// FinishReason is set on Kind == "done" ("stop" | "tool_calls" |
	// "length" | "content_filter"). Callers use it to decide whether
	// to loop (more tool rounds needed) or terminate.
	FinishReason string `json:"finish_reason,omitempty"`
	// Error message for Kind == "error". Streams terminate after.
	Error string `json:"error,omitempty"`
}

// StreamingProvider is the optional interface a Provider can implement
// to support token-by-token streaming + tool calling. Providers that
// don't support it stay on the legacy Chat() path; the handler picks
// the streaming variant only when this assertion succeeds.
//
// ChatStream returns a channel that closes when the stream ends.
// Cancelling ctx unblocks the channel and tears down the underlying
// HTTP connection. priorTools is the optional prior-round tool
// results the caller must echo back to the model (OpenAI requires
// this; we just feed them as role:"tool" messages internally).
type StreamingProvider interface {
	Provider
	ChatStream(
		ctx context.Context,
		system string,
		messages []ChatMessage,
		tools []ToolSpec,
		priorToolResults []ToolResult,
	) (<-chan StreamEvent, error)
}
