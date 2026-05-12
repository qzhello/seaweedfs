package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// OpenAICompat speaks the /chat/completions Bearer-token API contract used by
// OpenAI, DeepSeek, Together.ai, Groq, Ollama (with --openai-compat), and any
// LLM gateway that proxies to the same shape (Claude Code Router, OneAPI…).
//
// Differs from internal/ai/openai.go in that the base URL and model are fully
// driven by the persisted ai_providers row instead of static config.
type OpenAICompat struct {
	label   string
	apiKey  string
	model   string
	baseURL string
	http    *http.Client
}

// OpenAICompatOpts is the JSON-decoded form of ai_providers.config for
// OpenAI-compatible vendors.
type OpenAICompatOpts struct {
	Model   string `json:"model"`
	BaseURL string `json:"base_url"`
}

// NewOpenAICompat builds a client. apiKey must already be decrypted.
func NewOpenAICompat(label, apiKey string, opts OpenAICompatOpts, timeout time.Duration) (*OpenAICompat, error) {
	if apiKey == "" {
		return nil, fmt.Errorf("%s: api key is empty", label)
	}
	if opts.BaseURL == "" {
		return nil, fmt.Errorf("%s: base_url is required", label)
	}
	if opts.Model == "" {
		return nil, fmt.Errorf("%s: model is required", label)
	}
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	return &OpenAICompat{
		label:   label,
		apiKey:  apiKey,
		model:   opts.Model,
		baseURL: strings.TrimRight(opts.BaseURL, "/"),
		http:    &http.Client{Timeout: timeout},
	}, nil
}

func (o *OpenAICompat) Name() string { return o.label + ":" + o.model }

func (o *OpenAICompat) Explain(ctx context.Context, in ExplainInput) (string, error) {
	prompt := fmt.Sprintf(`You are a storage tiering analyst. A volume scoring engine produced this result:
volume_id=%d collection=%q readonly=%t action=%s score=%.3f
features=%v

In <=2 sentences, explain to an SRE why this action is recommended and call out the single biggest risk.`,
		in.VolumeID, in.Collection, in.ReadOnly, in.Action, in.Score, in.Features)
	body, _ := json.Marshal(map[string]any{
		"model":       o.model,
		"temperature": 0.2,
		"messages": []map[string]string{
			{"role": "system", "content": "Be concise, technical, no marketing language."},
			{"role": "user", "content": prompt},
		},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("build %s request: %w", o.label, err)
	}
	req.Header.Set("Authorization", "Bearer "+o.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := o.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("%s call: %w", o.label, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		buf := make([]byte, 256)
		n, _ := resp.Body.Read(buf)
		return "", fmt.Errorf("%s status %d: %s", o.label, resp.StatusCode, strings.TrimSpace(string(buf[:n])))
	}
	var out struct {
		Choices []struct{ Message struct{ Content string } }
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("decode %s: %w", o.label, err)
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("%s empty response", o.label)
	}
	return strings.TrimSpace(out.Choices[0].Message.Content), nil
}

func (o *OpenAICompat) Predict(_ context.Context, f map[string]float64) (float64, error) {
	// LLMs don't return calibrated probabilities; defer to the rule provider.
	return (&Rule{}).Predict(nil, f)
}

// Chat drives a multi-turn conversation with an explicit system prompt.
// Used by the floating operator-assistant feature.
func (o *OpenAICompat) Chat(ctx context.Context, system string, messages []ChatMessage) (string, error) {
	msgs := make([]map[string]string, 0, len(messages)+1)
	if system != "" {
		msgs = append(msgs, map[string]string{"role": "system", "content": system})
	}
	for _, m := range messages {
		role := m.Role
		if role != "user" && role != "assistant" {
			role = "user"
		}
		msgs = append(msgs, map[string]string{"role": role, "content": m.Content})
	}
	body, _ := json.Marshal(map[string]any{
		"model":       o.model,
		"temperature": 0.3,
		"max_tokens":  2048,
		"messages":    msgs,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("build %s request: %w", o.label, err)
	}
	req.Header.Set("Authorization", "Bearer "+o.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := o.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("%s call: %w", o.label, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		buf := make([]byte, 256)
		n, _ := resp.Body.Read(buf)
		return "", fmt.Errorf("%s status %d: %s", o.label, resp.StatusCode, strings.TrimSpace(string(buf[:n])))
	}
	var out struct {
		Choices []struct{ Message struct{ Content string } }
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("decode %s: %w", o.label, err)
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("%s empty response", o.label)
	}
	return strings.TrimSpace(out.Choices[0].Message.Content), nil
}

// JSONChat issues a freeform prompt and returns the raw assistant message.
// Used by the multi-round AI review orchestrator to drive structured prompts
// without forcing them through Explain's fixed template.
func (o *OpenAICompat) JSONChat(ctx context.Context, prompt string) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"model":       o.model,
		"temperature": 0.1, // low — we want deterministic structured output
		"messages": []map[string]string{
			{"role": "system", "content": "Reply with strict JSON only. No prose."},
			{"role": "user", "content": prompt},
		},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("build %s request: %w", o.label, err)
	}
	req.Header.Set("Authorization", "Bearer "+o.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := o.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("%s call: %w", o.label, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		buf := make([]byte, 256)
		n, _ := resp.Body.Read(buf)
		return "", fmt.Errorf("%s status %d: %s", o.label, resp.StatusCode, strings.TrimSpace(string(buf[:n])))
	}
	var out struct {
		Choices []struct{ Message struct{ Content string } }
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("decode %s: %w", o.label, err)
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("%s empty response", o.label)
	}
	return strings.TrimSpace(out.Choices[0].Message.Content), nil
}

// Ping issues a tiny request to verify credentials + reachability. Used by
// the connection-test endpoint. Returns nil on 2xx.
func (o *OpenAICompat) Ping(ctx context.Context) error {
	body, _ := json.Marshal(map[string]any{
		"model":      o.model,
		"max_tokens": 1,
		"messages":   []map[string]string{{"role": "user", "content": "ping"}},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+o.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := o.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		buf := make([]byte, 256)
		n, _ := resp.Body.Read(buf)
		return fmt.Errorf("status %d: %s", resp.StatusCode, strings.TrimSpace(string(buf[:n])))
	}
	return nil
}
