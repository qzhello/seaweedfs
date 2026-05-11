package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/ai"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// listAIProvidersV2 returns every persisted provider with credential metadata
// (without ciphertext).
func listAIProvidersV2(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		rows, err := d.PG.ListAIProviders(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		current := ""
		if d.AI != nil {
			current = d.AI.Name()
		}
		c.JSON(http.StatusOK, gin.H{
			"items":     rows,
			"current":   current,
			"vendors":   supportedVendors(),
			"templates": vendorTemplates(),
		})
	}
}

// upsertAIProvider creates or updates one provider. The plaintext API key,
// when present, is encrypted using the master AES-GCM key before persisting.
func upsertAIProvider(d Deps) gin.HandlerFunc {
	type req struct {
		ID          string          `json:"id,omitempty"`
		Kind        string          `json:"kind" binding:"required"`
		Name        string          `json:"name" binding:"required"`
		Config      json.RawMessage `json:"config"`
		SecretRef   string          `json:"secret_ref"`
		APIKey      string          `json:"api_key"`       // plaintext; only set when changing
		ClearSecret bool            `json:"clear_secret"`  // true ⇒ drop ciphertext, fall back to env
		Enabled     bool            `json:"enabled"`
		IsDefault   bool            `json:"is_default"`
	}
	return func(c *gin.Context) {
		var r req
		if err := c.ShouldBindJSON(&r); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if !validVendorKind(r.Kind) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported kind: " + r.Kind})
			return
		}
		if len(r.Config) == 0 {
			r.Config = json.RawMessage("{}")
		}

		var enc []byte
		if r.APIKey != "" {
			if d.Crypto == nil {
				c.JSON(http.StatusServiceUnavailable, gin.H{
					"error": "TIER_MASTER_KEY not loaded; cannot store API key. Set the env var and restart, or use secret_ref instead.",
				})
				return
			}
			ct, err := d.Crypto.Seal([]byte(r.APIKey))
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "encrypt: " + err.Error()})
				return
			}
			enc = ct
		}

		in := store.UpsertAIProviderInput{
			Kind:        r.Kind,
			Name:        r.Name,
			Config:      r.Config,
			SecretRef:   r.SecretRef,
			SecretEnc:   enc,
			Enabled:     r.Enabled,
			IsDefault:   r.IsDefault,
			ClearSecret: r.ClearSecret,
		}
		if r.ID != "" {
			id, err := uuid.Parse(r.ID)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
				return
			}
			in.ID = &id
		}
		id, err := d.PG.UpsertAIProvider(c.Request.Context(), in)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"id": id})
	}
}

func deleteAIProvider(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		if err := d.PG.DeleteAIProvider(c.Request.Context(), id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.Status(http.StatusNoContent)
	}
}

// testAIProvider builds a live client for the persisted row, calls Ping, and
// records the result in last_test_*. Returns latency on success.
func testAIProvider(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
			return
		}
		row, err := d.PG.GetAIProviderWithSecret(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		resolver := ai.NewResolver(d.Crypto, 15*time.Second)
		provider, err := resolver.Build(row)
		if err != nil {
			recordTestFail(c.Request.Context(), d, id, err)
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": err.Error()})
			return
		}

		probe, ok := provider.(ai.PingAdapter)
		if !ok {
			// Rule provider — nothing to test.
			_ = d.PG.RecordAITestResult(c.Request.Context(), id, true, "no-op (rule provider)", 0)
			c.JSON(http.StatusOK, gin.H{"ok": true, "skipped": true, "name": provider.Name()})
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
		defer cancel()
		start := time.Now()
		if err := probe.Ping(ctx); err != nil {
			recordTestFail(c.Request.Context(), d, id, err)
			c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": err.Error()})
			return
		}
		latency := int(time.Since(start) / time.Millisecond)
		_ = d.PG.RecordAITestResult(c.Request.Context(), id, true, "", latency)
		c.JSON(http.StatusOK, gin.H{"ok": true, "latency_ms": latency, "name": provider.Name()})
	}
}

func recordTestFail(ctx context.Context, d Deps, id uuid.UUID, err error) {
	msg := err.Error()
	if len(msg) > 500 {
		msg = msg[:500]
	}
	_ = d.PG.RecordAITestResult(ctx, id, false, msg, 0)
}

// ----- vendor metadata exposed to the UI ---------------------------------

type vendorTemplate struct {
	Kind     string                 `json:"kind"`
	Label    string                 `json:"label"`
	Doc      string                 `json:"doc"`
	Defaults map[string]interface{} `json:"defaults"`
	KeyHint  string                 `json:"key_hint"`
}

func supportedVendors() []string {
	return []string{"openai", "anthropic", "deepseek", "openai_compatible", "ollama", "rule"}
}

func validVendorKind(k string) bool {
	for _, v := range supportedVendors() {
		if v == k {
			return true
		}
	}
	return false
}

func vendorTemplates() []vendorTemplate {
	return []vendorTemplate{
		{
			Kind:    "openai",
			Label:   "OpenAI",
			Doc:     "GPT-4o / GPT-4o-mini / o1.使用 OpenAI 官方 API 端点。",
			KeyHint: "sk-…",
			Defaults: map[string]interface{}{
				"base_url": "https://api.openai.com/v1",
				"model":    "gpt-4o-mini",
			},
		},
		{
			Kind:    "anthropic",
			Label:   "Anthropic Claude",
			Doc:     "Claude Opus / Sonnet / Haiku.官方 Messages API。",
			KeyHint: "sk-ant-…",
			Defaults: map[string]interface{}{
				"model": "claude-haiku-4-5",
			},
		},
		{
			Kind:    "deepseek",
			Label:   "DeepSeek",
			Doc:     "DeepSeek-V3 / DeepSeek-Coder.OpenAI 兼容协议。",
			KeyHint: "sk-…",
			Defaults: map[string]interface{}{
				"base_url": "https://api.deepseek.com/v1",
				"model":    "deepseek-chat",
			},
		},
		{
			Kind:    "openai_compatible",
			Label:   "自定义 (OpenAI 兼容)",
			Doc:     "Claude Code Router / OneAPI / Together / Groq / 任何 OpenAI 兼容网关。",
			KeyHint: "依网关而定",
			Defaults: map[string]interface{}{
				"base_url": "http://localhost:8001/v1",
				"model":    "auto",
			},
		},
		{
			Kind:    "ollama",
			Label:   "Ollama (本地)",
			Doc:     "本地推理.需要 ollama serve 启动后开 OpenAI 兼容端点。",
			KeyHint: "本地部署可填任意值,如 ollama",
			Defaults: map[string]interface{}{
				"base_url": "http://localhost:11434/v1",
				"model":    "llama3.1",
			},
		},
		{
			Kind:    "rule",
			Label:   "Rule (无 AI)",
			Doc:     "纯规则解释,不调用任何外部模型。无凭据需求。",
			KeyHint: "无",
			Defaults: map[string]interface{}{},
		},
	}
}

