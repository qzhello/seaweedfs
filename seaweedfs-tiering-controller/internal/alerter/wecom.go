package alerter

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// deliver dispatches a single channel send. Each kind has its own payload shape.
func deliver(ctx context.Context, c store.AlertChannel, e Event) error {
	switch c.Kind {
	case "wecom_robot":
		return sendWeCom(ctx, c, e)
	case "dingtalk_robot":
		return sendDingTalk(ctx, c, e)
	case "feishu_robot":
		return sendFeishu(ctx, c, e)
	case "webhook":
		return sendWebhook(ctx, c, e)
	default:
		return fmt.Errorf("unknown channel kind %q", c.Kind)
	}
}

// ---------------- WeCom (企业微信) robot ----------------

type wecomConfig struct {
	Webhook        string   `json:"webhook"`
	MentionMobiles []string `json:"mention_mobiles,omitempty"`
	MentionUserIDs []string `json:"mention_user_ids,omitempty"`
}

func sendWeCom(ctx context.Context, c store.AlertChannel, e Event) error {
	var cfg wecomConfig
	if err := json.Unmarshal(c.Config, &cfg); err != nil {
		return fmt.Errorf("parse wecom config: %w", err)
	}
	if cfg.Webhook == "" {
		return fmt.Errorf("wecom webhook empty")
	}

	// Markdown body. WeCom supports limited markdown; bold + colored quotes work.
	color := "info"
	switch e.Severity {
	case "warning":
		color = "warning"
	case "critical":
		color = "comment"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "## <font color=\"%s\">%s</font>\n", color, escape(e.Title))
	fmt.Fprintf(&b, "**Severity**: %s · **Source**: `%s`\n", e.Severity, escape(e.Source))
	fmt.Fprintf(&b, "**Time**: %s\n", e.At.Format("2006-01-02 15:04:05"))
	if e.Body != "" {
		fmt.Fprintf(&b, "\n%s\n", escape(e.Body))
	}

	payload := map[string]interface{}{
		"msgtype": "markdown",
		"markdown": map[string]interface{}{
			"content": b.String(),
		},
	}
	// Mentions only fire on critical to avoid alert fatigue.
	if e.Severity == "critical" && (len(cfg.MentionMobiles) > 0 || len(cfg.MentionUserIDs) > 0) {
		// WeCom markdown does not support @ — fall back to text msg with mentions.
		text := fmt.Sprintf("[%s] %s\nsource: %s\n%s", strings.ToUpper(e.Severity), e.Title, e.Source, e.Body)
		payload = map[string]interface{}{
			"msgtype": "text",
			"text": map[string]interface{}{
				"content":               text,
				"mentioned_mobile_list": cfg.MentionMobiles,
				"mentioned_list":        cfg.MentionUserIDs,
			},
		}
	}
	return postJSON(ctx, cfg.Webhook, payload)
}

// ---------------- DingTalk robot (placeholder for parity) ----------------

type dingTalkConfig struct {
	Webhook string `json:"webhook"`
}

func sendDingTalk(ctx context.Context, c store.AlertChannel, e Event) error {
	var cfg dingTalkConfig
	if err := json.Unmarshal(c.Config, &cfg); err != nil {
		return fmt.Errorf("parse dingtalk config: %w", err)
	}
	if cfg.Webhook == "" {
		return fmt.Errorf("dingtalk webhook empty")
	}
	payload := map[string]interface{}{
		"msgtype": "markdown",
		"markdown": map[string]interface{}{
			"title": fmt.Sprintf("[%s] %s", strings.ToUpper(e.Severity), e.Title),
			"text": fmt.Sprintf("### %s\n- severity: %s\n- source: `%s`\n- at: %s\n\n%s",
				escape(e.Title), e.Severity, escape(e.Source),
				e.At.Format(time.RFC3339), escape(e.Body)),
		},
	}
	return postJSON(ctx, cfg.Webhook, payload)
}

// ---------------- Feishu robot ----------------

type feishuConfig struct {
	Webhook string `json:"webhook"`
}

func sendFeishu(ctx context.Context, c store.AlertChannel, e Event) error {
	var cfg feishuConfig
	if err := json.Unmarshal(c.Config, &cfg); err != nil {
		return fmt.Errorf("parse feishu config: %w", err)
	}
	if cfg.Webhook == "" {
		return fmt.Errorf("feishu webhook empty")
	}
	payload := map[string]interface{}{
		"msg_type": "interactive",
		"card": map[string]interface{}{
			"header": map[string]interface{}{
				"title":    map[string]string{"tag": "plain_text", "content": fmt.Sprintf("[%s] %s", strings.ToUpper(e.Severity), e.Title)},
				"template": feishuColor(e.Severity),
			},
			"elements": []map[string]interface{}{
				{"tag": "div", "text": map[string]string{
					"tag":     "lark_md",
					"content": fmt.Sprintf("**source**: `%s`\n**at**: %s\n\n%s", escape(e.Source), e.At.Format(time.RFC3339), escape(e.Body)),
				}},
			},
		},
	}
	return postJSON(ctx, cfg.Webhook, payload)
}

func feishuColor(sev string) string {
	switch sev {
	case "critical":
		return "red"
	case "warning":
		return "orange"
	default:
		return "blue"
	}
}

// ---------------- Generic webhook ----------------

type webhookConfig struct {
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
}

func sendWebhook(ctx context.Context, c store.AlertChannel, e Event) error {
	var cfg webhookConfig
	if err := json.Unmarshal(c.Config, &cfg); err != nil {
		return fmt.Errorf("parse webhook config: %w", err)
	}
	if cfg.URL == "" {
		return fmt.Errorf("webhook url empty")
	}
	body, _ := json.Marshal(e)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.URL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range cfg.Headers {
		req.Header.Set(k, v)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	return nil
}

// ---------------- helpers ----------------

func postJSON(ctx context.Context, url string, payload interface{}) error {
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	// WeCom returns {errcode, errmsg} — non-zero errcode is failure even on 200.
	var r struct {
		Errcode int    `json:"errcode"`
		Errmsg  string `json:"errmsg"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&r)
	if r.Errcode != 0 {
		return fmt.Errorf("provider errcode=%d msg=%s", r.Errcode, r.Errmsg)
	}
	return nil
}

func escape(s string) string {
	return strings.NewReplacer(
		"<", "&lt;", ">", "&gt;",
	).Replace(s)
}
