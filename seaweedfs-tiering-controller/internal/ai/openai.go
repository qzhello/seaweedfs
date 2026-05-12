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

type OpenAI struct {
	apiKey  string
	model   string
	baseURL string
	http    *http.Client
}

func NewOpenAI(c config.AIVendor, timeout time.Duration) (*OpenAI, error) {
	key := c.APIKey
	if strings.HasPrefix(key, "env:") {
		key = os.Getenv(strings.TrimPrefix(key, "env:"))
	}
	if key == "" {
		key = os.Getenv("OPENAI_API_KEY")
	}
	if key == "" {
		return nil, fmt.Errorf("openai api key not configured")
	}
	base := c.BaseURL
	if base == "" {
		base = "https://api.openai.com/v1"
	}
	model := c.Model
	if model == "" {
		model = "gpt-4o-mini"
	}
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	return &OpenAI{apiKey: key, model: model, baseURL: base, http: &http.Client{Timeout: timeout}}, nil
}

func (o *OpenAI) Name() string { return "openai:" + o.model }

func (o *OpenAI) Explain(ctx context.Context, in ExplainInput) (string, error) {
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
		return "", fmt.Errorf("build openai request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+o.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := o.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("openai call: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("openai status %d", resp.StatusCode)
	}
	var out struct {
		Choices []struct{ Message struct{ Content string } }
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("decode openai response: %w", err)
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("openai empty response")
	}
	return strings.TrimSpace(out.Choices[0].Message.Content), nil
}

func (o *OpenAI) Predict(_ context.Context, f map[string]float64) (float64, error) {
	// LLMs are bad at calibrated probabilities; fall back to the rule provider.
	return (&Rule{}).Predict(nil, f)
}

// Chat drives a multi-turn conversation with an explicit system prompt.
// Used by the floating operator-assistant feature.
func (o *OpenAI) Chat(ctx context.Context, system string, messages []ChatMessage) (string, error) {
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
		return "", fmt.Errorf("build openai request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+o.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := o.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("openai call: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("openai status %d", resp.StatusCode)
	}
	var out struct {
		Choices []struct{ Message struct{ Content string } }
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("decode openai response: %w", err)
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("openai empty response")
	}
	return strings.TrimSpace(out.Choices[0].Message.Content), nil
}
