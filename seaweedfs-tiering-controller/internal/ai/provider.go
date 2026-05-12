// Package ai provides a pluggable AI provider interface so the platform can
// swap OpenAI / Anthropic / local rule-engine without touching scorer code.
package ai

import (
	"context"
	"fmt"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/config"
)

type ExplainInput struct {
	VolumeID   uint32
	Collection string
	Action     string
	Score      float64
	ReadOnly   bool
	Features   map[string]float64
}

// ChatMessage is one turn in a multi-turn assistant conversation.
type ChatMessage struct {
	Role    string // "user" or "assistant"
	Content string
}

// Provider is the small surface every AI implementation must satisfy.
type Provider interface {
	Name() string
	Explain(ctx context.Context, in ExplainInput) (string, error)
	// Predict returns a future-access probability in [0,1]. May be a no-op for rule providers.
	Predict(ctx context.Context, features map[string]float64) (float64, error)
	// Chat drives a multi-turn conversation with an explicit system prompt.
	// Used by the floating operator assistant.
	Chat(ctx context.Context, system string, messages []ChatMessage) (string, error)
}

// Build resolves the configured provider, then wraps it with Prometheus
// instrumentation so callers see one Provider with metrics for free.
func Build(c *config.AI) (Provider, error) {
	var p Provider
	var err error
	switch c.Provider {
	case "openai":
		p, err = NewOpenAI(c.OpenAI, c.RequestTimeout)
	case "anthropic":
		p, err = NewAnthropic(c.Anthropic, c.RequestTimeout)
	case "rule", "":
		p = NewRule()
	default:
		return nil, fmt.Errorf("unknown ai provider %q", c.Provider)
	}
	if err != nil {
		return nil, err
	}
	return wrap(p), nil
}
