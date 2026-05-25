package ai

import (
	"context"
	"time"
)

// Usage is the per-call token accounting reported by the LLM vendor.
// All fields are best-effort: a vendor that doesn't return usage (or
// a streaming call without include_usage) will simply leave them at
// zero. Callers must treat zero as "unknown", not "free".
type Usage struct {
	Provider     string        // e.g. "openai", "anthropic", "deepseek"
	Model        string        // exact model name as reported in Provider.Name()
	Operation    string        // "chat" | "jsonchat" | "explain"
	InputTokens  int64         // prompt tokens
	OutputTokens int64         // completion / response tokens
	Latency      time.Duration // wall-clock time to receive the response
	Err          string        // empty on success; provider error message otherwise
	OccurredAt   time.Time     // event timestamp; defaults to time.Now() on emit
}

// UsageRecorder is the side-effect the caller wires in via context.
// Providers invoke it after every call so the API layer can persist
// the event without the Provider interface needing to grow a new
// return value. A nil recorder (no value in context) is a no-op.
type UsageRecorder func(Usage)

type usageRecorderKey struct{}

// WithUsageRecorder attaches a recorder to ctx. Providers downstream
// will invoke it once per finished call. Set it at the per-request
// boundary (an HTTP handler) so usage rows are attributable.
func WithUsageRecorder(ctx context.Context, r UsageRecorder) context.Context {
	if r == nil {
		return ctx
	}
	return context.WithValue(ctx, usageRecorderKey{}, r)
}

// recorderFromContext is the provider-side counterpart. Returns nil
// when no recorder is set — providers should range-check before
// calling.
func recorderFromContext(ctx context.Context) UsageRecorder {
	r, _ := ctx.Value(usageRecorderKey{}).(UsageRecorder)
	return r
}

// emitUsage is the helper providers call from the tail of each
// request. It fills in OccurredAt / Latency if the caller left them
// zero, then dispatches. Cheap enough to call unconditionally.
func emitUsage(ctx context.Context, u Usage) {
	r := recorderFromContext(ctx)
	if r == nil {
		return
	}
	if u.OccurredAt.IsZero() {
		u.OccurredAt = time.Now()
	}
	r(u)
}
