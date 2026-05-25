package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// streamingClient is a separate HTTP client without a hard timeout —
// SSE streams must stay open indefinitely while tokens trickle in.
// Cancellation is governed by ctx, not by client.Timeout.
var streamingClient = &http.Client{Timeout: 0}

// ChatStream implements StreamingProvider for OpenAI-compatible
// providers. It sends `stream: true` + an optional tools array, reads
// the SSE response, and forwards a typed event per token/tool call.
//
// Tool call arguments arrive as JSON fragments across many deltas;
// we buffer them per-index and emit a single ToolCall event only
// once the JSON parses cleanly. This keeps the executor from seeing
// half-parsed args.
//
// priorToolResults are appended after `messages` as role:"tool"
// turns so the model can see what its earlier calls produced. The
// final assistant message in `messages` must itself carry the
// matching ToolCalls (the OpenAI server requires the tool turns and
// the assistant turn that asked for them to round-trip together).
func (o *OpenAICompat) ChatStream(
	ctx context.Context,
	system string,
	messages []ChatMessage,
	tools []ToolSpec,
	priorToolResults []ToolResult,
) (<-chan StreamEvent, error) {
	// Build messages array in OpenAI format. The compat shape uses
	// `tool_calls` on assistant turns and a separate "tool" role for
	// results, so we can't use the simple map[string]string we use in
	// the non-streaming Chat path.
	type oaiMsg struct {
		Role       string        `json:"role"`
		Content    any           `json:"content,omitempty"` // string or null
		ToolCalls  []oaiToolCall `json:"tool_calls,omitempty"`
		ToolCallID string        `json:"tool_call_id,omitempty"`
		Name       string        `json:"name,omitempty"`
	}
	msgs := make([]oaiMsg, 0, len(messages)+len(priorToolResults)+1)
	if system != "" {
		msgs = append(msgs, oaiMsg{Role: "system", Content: system})
	}
	for _, m := range messages {
		out := oaiMsg{Role: m.Role}
		if m.Content != "" {
			out.Content = m.Content
		}
		if len(m.ToolCalls) > 0 {
			out.ToolCalls = make([]oaiToolCall, len(m.ToolCalls))
			for i, tc := range m.ToolCalls {
				out.ToolCalls[i] = oaiToolCall{
					ID:   tc.ID,
					Type: "function",
					Function: oaiFunctionCall{
						Name:      tc.Name,
						Arguments: string(tc.Arguments),
					},
				}
			}
		}
		if m.ToolCallID != "" {
			out.ToolCallID = m.ToolCallID
		}
		// Empty assistant messages with tool_calls need explicit null
		// content — OpenAI rejects "" as content for that case.
		if out.Content == nil && out.Role == "assistant" && len(out.ToolCalls) > 0 {
			out.Content = nil
		}
		msgs = append(msgs, out)
	}
	for _, r := range priorToolResults {
		msgs = append(msgs, oaiMsg{
			Role:       "tool",
			ToolCallID: r.CallID,
			Content:    r.Content,
		})
	}

	bodyMap := map[string]any{
		"model":       o.model,
		"temperature": 0.3,
		"max_tokens":  2048,
		"stream":      true,
		"messages":    msgs,
		// Ask the server to include a final usage block in the SSE
		// stream. Without this the streaming path has no way to
		// surface token counts to the usage recorder.
		"stream_options": map[string]any{"include_usage": true},
	}
	if len(tools) > 0 {
		bodyMap["tools"] = toOpenAITools(tools)
		// Let the model decide whether to call a tool or answer
		// directly. "auto" is the OpenAI default but explicit is
		// clearer in logs.
		bodyMap["tool_choice"] = "auto"
	}
	body, err := json.Marshal(bodyMap)
	if err != nil {
		return nil, fmt.Errorf("marshal stream body: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build stream request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+o.apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")

	resp, err := streamingClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("stream call: %w", err)
	}
	if resp.StatusCode/100 != 2 {
		buf, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return nil, fmt.Errorf("status %d: %s", resp.StatusCode, strings.TrimSpace(string(buf)))
	}

	out := make(chan StreamEvent, 16)
	streamStart := time.Now()
	provider, model := o.label, o.model
	go func() {
		defer close(out)
		defer resp.Body.Close()
		readStream(ctx, resp.Body, out, provider, model, streamStart)
	}()
	return out, nil
}

// readStream walks SSE events, accumulates per-index tool calls, and
// emits typed events on the output channel. The channel close signals
// stream end; callers must treat a missing "done" event as an error.
//
// usageCtx / provider / model / start are passed through so the final
// chunk's usage block (when stream_options.include_usage was set) can
// be forwarded to the recorder attached to the original request ctx.
func readStream(usageCtx context.Context, r io.Reader, out chan<- StreamEvent, provider, model string, start time.Time) {
	var sawUsage bool
	defer func() {
		// Always emit something — even a usage row with zero token
		// counts is useful as an attempt counter. The recorder can
		// distinguish "unknown" from "zero" by checking tokens > 0.
		if !sawUsage {
			emitUsage(usageCtx, Usage{
				Provider: provider, Model: model, Operation: "chat_stream",
				Latency: time.Since(start),
			})
		}
	}()
	scanner := bufio.NewScanner(r)
	// 1 MiB line buffer — some providers ship base64-encoded tool args
	// in a single SSE frame and the default 64 KiB scanner blows up.
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)

	// Pending tool calls buffered by index; we don't know the call ID
	// or full args until the deltas stop arriving for that index.
	pending := map[int]*ToolCall{} // index → accumulator

	emit := func(ev StreamEvent) {
		select {
		case out <- ev:
		case <-time.After(30 * time.Second):
			// Consumer is gone or dead; abandon the stream.
		}
	}
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var chunk struct {
			Choices []struct {
				Index int `json:"index"`
				Delta struct {
					Content   string        `json:"content"`
					ToolCalls []oaiToolCall `json:"tool_calls"`
				} `json:"delta"`
				FinishReason string `json:"finish_reason"`
			} `json:"choices"`
			// OpenAI emits the usage block on the very last SSE frame
			// when stream_options.include_usage=true. Choices is empty
			// on that frame.
			Usage *openAIUsage `json:"usage,omitempty"`
		}
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			// Skip malformed frames; vendors occasionally emit
			// keepalives or comments.
			continue
		}
		if chunk.Usage != nil {
			emitUsage(usageCtx, Usage{
				Provider: provider, Model: model, Operation: "chat_stream",
				InputTokens:  chunk.Usage.PromptTokens,
				OutputTokens: chunk.Usage.CompletionTokens,
				Latency:      time.Since(start),
			})
			sawUsage = true
		}
		for _, ch := range chunk.Choices {
			if ch.Delta.Content != "" {
				emit(StreamEvent{Kind: "token", Token: ch.Delta.Content})
			}
			for _, tc := range ch.Delta.ToolCalls {
				idx := 0
				if tc.Index != nil {
					idx = *tc.Index
				}
				acc, ok := pending[idx]
				if !ok {
					acc = &ToolCall{}
					pending[idx] = acc
				}
				if tc.ID != "" {
					acc.ID = tc.ID
				}
				if tc.Function.Name != "" {
					acc.Name = tc.Function.Name
				}
				if tc.Function.Arguments != "" {
					acc.Arguments = append(acc.Arguments, tc.Function.Arguments...)
				}
			}
			if ch.FinishReason != "" {
				// Flush any pending tool calls before announcing done.
				for _, acc := range pending {
					if acc.Name == "" {
						continue
					}
					// Validate args are JSON-parseable; if not, wrap
					// in an empty object so the executor doesn't
					// crash. The model will see the result and try
					// again.
					if len(acc.Arguments) == 0 || !json.Valid(acc.Arguments) {
						acc.Arguments = json.RawMessage(`{}`)
					}
					emit(StreamEvent{Kind: "tool_call", ToolCall: acc})
				}
				pending = map[int]*ToolCall{}
				emit(StreamEvent{Kind: "done", FinishReason: ch.FinishReason})
				return
			}
		}
	}
	if err := scanner.Err(); err != nil {
		emit(StreamEvent{Kind: "error", Error: err.Error()})
		return
	}
	// Stream ended without a finish_reason — surface as error so the
	// handler can retry or give up cleanly.
	emit(StreamEvent{Kind: "error", Error: "stream closed without finish_reason"})
}

// oaiToolCall mirrors OpenAI's tool_call delta shape. Index can be
// missing on the very first delta of a call, so we model it as a
// pointer to keep zero-value distinct from "explicit 0".
type oaiToolCall struct {
	Index    *int            `json:"index,omitempty"`
	ID       string          `json:"id,omitempty"`
	Type     string          `json:"type,omitempty"`
	Function oaiFunctionCall `json:"function,omitempty"`
}

type oaiFunctionCall struct {
	Name      string `json:"name,omitempty"`
	Arguments string `json:"arguments,omitempty"`
}

// toOpenAITools renders the cross-vendor ToolSpec slice into OpenAI's
// `tools` request param. Schema is forwarded verbatim — we already
// emit JSON Schema in tools.go.
func toOpenAITools(specs []ToolSpec) []map[string]any {
	out := make([]map[string]any, 0, len(specs))
	for _, s := range specs {
		var schema any
		if len(s.Schema) > 0 {
			_ = json.Unmarshal(s.Schema, &schema)
		} else {
			schema = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		out = append(out, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        s.Name,
				"description": s.Description,
				"parameters":  schema,
			},
		})
	}
	return out
}
