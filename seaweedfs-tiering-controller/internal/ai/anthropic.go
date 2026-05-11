package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/config"
)

type Anthropic struct {
	apiKey  string
	model   string
	baseURL string
	timeout time.Duration
	http    *http.Client
}

func NewAnthropic(c config.AIVendor, timeout time.Duration) (*Anthropic, error) {
	key := c.APIKey
	if strings.HasPrefix(key, "env:") {
		key = os.Getenv(strings.TrimPrefix(key, "env:"))
	}
	if key == "" {
		key = os.Getenv("ANTHROPIC_API_KEY")
	}
	if key == "" {
		return nil, fmt.Errorf("anthropic api key not configured")
	}
	model := c.Model
	if model == "" {
		model = "claude-haiku-4-5"
	}
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	return &Anthropic{apiKey: key, model: model, timeout: timeout, http: &http.Client{Timeout: timeout}}, nil
}

func (a *Anthropic) Name() string { return "anthropic:" + a.model }

func (a *Anthropic) Explain(ctx context.Context, in ExplainInput) (string, error) {
	prompt := fmt.Sprintf(`Volume %d (collection=%q, readonly=%t) was scored %.3f → action=%s. Features: %v
Explain the recommendation and the biggest risk in <=2 sentences. Plain technical English.`,
		in.VolumeID, in.Collection, in.ReadOnly, in.Score, in.Action, in.Features)
	body, _ := json.Marshal(map[string]any{
		"model":      a.model,
		"max_tokens": 256,
		"messages": []map[string]any{
			{"role": "user", "content": prompt},
		},
	})
	endpoint := a.baseURL
	if endpoint == "" {
		endpoint = "https://api.anthropic.com"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(endpoint, "/")+"/v1/messages", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("build anthropic request: %w", err)
	}
	req.Header.Set("x-api-key", a.apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("anthropic call: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("anthropic status %d", resp.StatusCode)
	}
	var out struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("decode anthropic response: %w", err)
	}
	for _, c := range out.Content {
		if c.Type == "text" {
			return strings.TrimSpace(c.Text), nil
		}
	}
	return "", fmt.Errorf("anthropic empty response")
}

func (a *Anthropic) Predict(_ context.Context, f map[string]float64) (float64, error) {
	return (&Rule{}).Predict(nil, f)
}

// JSONChat issues a raw prompt and returns the assistant text. Used by the
// aireview orchestrator to drive structured-JSON prompts.
func (a *Anthropic) JSONChat(ctx context.Context, prompt string) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"model":       a.model,
		"max_tokens":  1024,
		"temperature": 0.1,
		"system":      "Reply with strict JSON only. No prose.",
		"messages": []map[string]any{
			{"role": "user", "content": prompt},
		},
	})
	endpoint := a.baseURL
	if endpoint == "" {
		endpoint = "https://api.anthropic.com"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(endpoint, "/")+"/v1/messages", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("build anthropic request: %w", err)
	}
	req.Header.Set("x-api-key", a.apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("anthropic call: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("anthropic status %d", resp.StatusCode)
	}
	var out struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("decode anthropic response: %w", err)
	}
	for _, c := range out.Content {
		if c.Type == "text" {
			return strings.TrimSpace(c.Text), nil
		}
	}
	return "", fmt.Errorf("anthropic empty response")
}
