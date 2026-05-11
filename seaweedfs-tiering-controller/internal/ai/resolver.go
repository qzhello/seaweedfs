package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/crypto"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// Resolver builds a live Provider from one ai_providers row, decrypting the
// stored credential via the master AES-GCM key. Falls back to env-var lookup
// when the row carries only a secret_ref.
type Resolver struct {
	enc     *crypto.AESGCM
	timeout time.Duration
}

// NewResolver constructs a resolver. If enc is nil, only env-var-backed rows
// will work — encrypted rows will fail with a clear error.
func NewResolver(enc *crypto.AESGCM, timeout time.Duration) *Resolver {
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	return &Resolver{enc: enc, timeout: timeout}
}

// Build resolves a provider row to a callable Provider. The returned provider
// is NOT instrumentation-wrapped; callers should pass it through wrap() if
// they want metrics + last_used tracking.
func (r *Resolver) Build(row *store.AIProvider) (Provider, error) {
	apiKey, err := r.resolveSecret(row)
	if err != nil {
		return nil, err
	}

	switch row.Kind {
	case "rule":
		return NewRule(), nil

	case "openai", "deepseek", "openai_compatible", "ollama":
		var opts OpenAICompatOpts
		if err := json.Unmarshal(row.Config, &opts); err != nil {
			return nil, fmt.Errorf("decode %s config: %w", row.Kind, err)
		}
		// Vendor-specific defaults so a half-filled config still works.
		applyDefaults(row.Kind, &opts)
		return NewOpenAICompat(row.Kind, apiKey, opts, r.timeout)

	case "anthropic":
		var opts struct {
			Model   string `json:"model"`
			BaseURL string `json:"base_url"`
		}
		if err := json.Unmarshal(row.Config, &opts); err != nil {
			return nil, fmt.Errorf("decode anthropic config: %w", err)
		}
		if opts.Model == "" {
			opts.Model = "claude-3-5-sonnet-latest"
		}
		return &Anthropic{
			apiKey:  apiKey,
			model:   opts.Model,
			baseURL: opts.BaseURL,
			timeout: r.timeout,
			http:    &http.Client{Timeout: r.timeout},
		}, nil

	default:
		return nil, fmt.Errorf("unsupported ai provider kind %q", row.Kind)
	}
}

// resolveSecret returns the plaintext API key, preferring encrypted secret,
// falling back to secret_ref env var, finally to a vendor-default env var.
func (r *Resolver) resolveSecret(row *store.AIProvider) (string, error) {
	if len(row.SecretEnc) > 0 {
		if r.enc == nil {
			return "", fmt.Errorf("encrypted secret present but TIER_MASTER_KEY not loaded")
		}
		pt, err := r.enc.Open(row.SecretEnc)
		if err != nil {
			return "", fmt.Errorf("decrypt %s secret: %w", row.Name, err)
		}
		return strings.TrimSpace(string(pt)), nil
	}
	if strings.HasPrefix(row.SecretRef, "env:") {
		return os.Getenv(strings.TrimPrefix(row.SecretRef, "env:")), nil
	}
	if row.SecretRef != "" {
		return os.Getenv(row.SecretRef), nil
	}
	// Vendor-default fallback.
	switch row.Kind {
	case "openai":
		return os.Getenv("OPENAI_API_KEY"), nil
	case "deepseek":
		return os.Getenv("DEEPSEEK_API_KEY"), nil
	case "anthropic":
		return os.Getenv("ANTHROPIC_API_KEY"), nil
	case "rule":
		return "", nil // rule provider doesn't need a key
	}
	return "", nil
}

func applyDefaults(kind string, o *OpenAICompatOpts) {
	switch kind {
	case "openai":
		if o.BaseURL == "" {
			o.BaseURL = "https://api.openai.com/v1"
		}
		if o.Model == "" {
			o.Model = "gpt-4o-mini"
		}
	case "deepseek":
		if o.BaseURL == "" {
			o.BaseURL = "https://api.deepseek.com/v1"
		}
		if o.Model == "" {
			o.Model = "deepseek-chat"
		}
	case "ollama":
		if o.BaseURL == "" {
			o.BaseURL = "http://localhost:11434/v1"
		}
		if o.Model == "" {
			o.Model = "llama3.1"
		}
	}
}

// PingAdapter is the optional interface a Provider can implement to support
// the connection test button. Defined here so callers don't import every
// concrete client. OpenAICompat satisfies this directly; Anthropic falls
// through to the generic Explain probe in api/ai_providers.go.
type PingAdapter interface {
	Ping(ctx context.Context) error
}

// Ping on Anthropic uses a tiny Explain to verify auth + reachability.
func (a *Anthropic) Ping(ctx context.Context) error {
	_, err := a.Explain(ctx, ExplainInput{VolumeID: 0, Action: "noop", Score: 0})
	return err
}
