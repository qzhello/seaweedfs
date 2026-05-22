package ai

import (
	"context"
	"time"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/metrics"
)

// instrumented wraps any Provider with Prometheus latency + error metrics.
// Used by Build() so the metrics layer is invisible to callers.
type instrumented struct {
	inner Provider
}

func wrap(p Provider) Provider { return &instrumented{inner: p} }

func (i *instrumented) Name() string { return i.inner.Name() }

func (i *instrumented) Explain(ctx context.Context, in ExplainInput) (string, error) {
	start := time.Now()
	out, err := i.inner.Explain(ctx, in)
	metrics.AIDuration.WithLabelValues(i.inner.Name(), "explain").
		Observe(time.Since(start).Seconds())
	if err != nil {
		metrics.AIErrors.WithLabelValues(i.inner.Name(), "explain").Inc()
	}
	return out, err
}

func (i *instrumented) Chat(ctx context.Context, system string, messages []ChatMessage) (string, error) {
	start := time.Now()
	out, err := i.inner.Chat(ctx, system, messages)
	metrics.AIDuration.WithLabelValues(i.inner.Name(), "chat").
		Observe(time.Since(start).Seconds())
	if err != nil {
		metrics.AIErrors.WithLabelValues(i.inner.Name(), "chat").Inc()
	}
	return out, err
}

func (i *instrumented) Predict(ctx context.Context, f map[string]float64) (float64, error) {
	start := time.Now()
	out, err := i.inner.Predict(ctx, f)
	metrics.AIDuration.WithLabelValues(i.inner.Name(), "predict").
		Observe(time.Since(start).Seconds())
	if err != nil {
		metrics.AIErrors.WithLabelValues(i.inner.Name(), "predict").Inc()
	}
	return out, err
}

// JSONChat is exposed by the OpenAI-compatible and Anthropic providers
// for the few call sites that need a freeform prompt that returns raw
// JSON (ops-template draft, skill draft-from-text). The Provider
// interface deliberately stays narrow, so we surface this method via
// duck-typing on the inner provider. Without this pass-through, the
// metrics wrapper would hide JSONChat and the handlers' type
// assertion `.(jsonChatter)` would silently fail.
func (i *instrumented) JSONChat(ctx context.Context, prompt string) (string, error) {
	type jsonChatter interface {
		JSONChat(ctx context.Context, prompt string) (string, error)
	}
	jc, ok := i.inner.(jsonChatter)
	if !ok {
		// The rule provider doesn't implement JSONChat; fall back
		// to a clear error rather than a panic so the handler can
		// degrade to "paste raw JSON" UX.
		return "", errNoJSONChat
	}
	start := time.Now()
	out, err := jc.JSONChat(ctx, prompt)
	metrics.AIDuration.WithLabelValues(i.inner.Name(), "jsonchat").
		Observe(time.Since(start).Seconds())
	if err != nil {
		metrics.AIErrors.WithLabelValues(i.inner.Name(), "jsonchat").Inc()
	}
	return out, err
}

// errNoJSONChat is the sentinel the wrapper returns when the inner
// provider can't do freeform JSON chat (e.g. the rule provider).
// Defined here so handlers can errors.Is against it if they want a
// specific "degrade to paste JSON" branch.
var errNoJSONChat = errJSONChatNotSupported{}

type errJSONChatNotSupported struct{}

func (errJSONChatNotSupported) Error() string {
	return "current AI provider does not support freeform JSON chat"
}
