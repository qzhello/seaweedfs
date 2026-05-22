package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"text/template"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/alerter"
	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

// opsTemplateAlerts is the wire shape persisted in
// ops_templates.alerts JSONB. Pointer fields use omitempty so a
// half-written config (e.g. only on_failure set) round-trips cleanly.
type opsTemplateAlerts struct {
	ChannelIDs      []uuid.UUID `json:"channel_ids,omitempty"`
	AlertTemplateID *uuid.UUID  `json:"alert_template_id,omitempty"`
	OnStart         bool        `json:"on_start"`
	OnSuccess       bool        `json:"on_success"`
	OnFailure       bool        `json:"on_failure"`
	OnAwaitConfirm  bool        `json:"on_await_confirm"`
	// Severity, when non-empty, overrides the per-status default.
	// Useful for "tag every event from this flow as critical".
	Severity string `json:"severity,omitempty"`
}

// alertTplVars is the variable bag exposed to alert-template
// rendering. Keep field names short and stable — they end up in
// operator-authored markdown templates.
type alertTplVars struct {
	Template  string
	Cluster   string
	Status    string // start | success | failure | await
	RunID     string
	StepID    string
	StepIndex int
	Error     string
	When      string
}

// decodeOpsTemplateAlerts parses the JSONB blob from the row.
// Returns nil on empty / null / parse errors so callers can treat
// "no config" as the default (silent) behaviour.
func decodeOpsTemplateAlerts(raw json.RawMessage) *opsTemplateAlerts {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var a opsTemplateAlerts
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil
	}
	if len(a.ChannelIDs) == 0 {
		return nil
	}
	return &a
}

// shouldFire returns true when the given status is enabled in the
// template's alert config.
func (a *opsTemplateAlerts) shouldFire(status string) bool {
	if a == nil {
		return false
	}
	switch status {
	case "start":
		return a.OnStart
	case "success":
		return a.OnSuccess
	case "failure":
		return a.OnFailure
	case "await":
		return a.OnAwaitConfirm
	}
	return false
}

// emitFlowAlert renders + dispatches a single per-flow event. Best
// effort: any failure (template parse, missing channel, etc.) is
// logged and swallowed so the run continues. d may be nil in tests.
func emitFlowAlert(
	ctx context.Context,
	d Deps,
	cfg *opsTemplateAlerts,
	tpl *store.OpsTemplate,
	clusterName string,
	runID uuid.UUID,
	status string,
	vars alertTplVars,
) {
	if cfg == nil || d.Alerts == nil {
		return
	}
	if !cfg.shouldFire(status) {
		return
	}

	vars.Template = tpl.Name
	vars.Cluster = clusterName
	vars.Status = status
	vars.RunID = runID.String()
	vars.When = time.Now().Format(time.RFC3339)

	title, body := renderAlertBody(ctx, d, cfg, vars)

	sev := cfg.Severity
	if sev == "" {
		sev = defaultSeverityFor(status)
	}

	d.Alerts.Emit(alerter.Event{
		Kind:       "ops_template." + status,
		Source:     tpl.Name,
		Severity:   sev,
		Title:      title,
		Body:       body,
		ChannelIDs: cfg.ChannelIDs,
		Payload: map[string]interface{}{
			"template_id": tpl.ID,
			"run_id":      runID,
			"cluster":     clusterName,
			"step_id":     vars.StepID,
			"step_index":  vars.StepIndex,
		},
	})
}

// renderAlertBody picks the alert template (if configured), renders
// it with vars, and falls back to a sensible default body when the
// template is missing or fails to parse.
func renderAlertBody(ctx context.Context, d Deps, cfg *opsTemplateAlerts, v alertTplVars) (string, string) {
	if cfg.AlertTemplateID != nil && d.PG != nil {
		at, err := d.PG.GetAlertTemplate(ctx, *cfg.AlertTemplateID)
		if err == nil {
			title := executeTmpl(at.TitleTmpl, v)
			body := executeTmpl(at.BodyTmpl, v)
			if title == "" {
				title = defaultTitle(v)
			}
			return title, body
		}
		if d.Log != nil {
			d.Log.Warn("alert template lookup failed",
				zap.String("id", cfg.AlertTemplateID.String()), zap.Error(err))
		}
	}
	return defaultTitle(v), defaultBody(v)
}

func executeTmpl(src string, v alertTplVars) string {
	if strings.TrimSpace(src) == "" {
		return ""
	}
	tmpl, err := template.New("alert").Parse(src)
	if err != nil {
		return fmt.Sprintf("(template parse error: %v)", err)
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, v); err != nil {
		return fmt.Sprintf("(template execute error: %v)", err)
	}
	return buf.String()
}

func defaultTitle(v alertTplVars) string {
	tag := strings.ToUpper(v.Status)
	return fmt.Sprintf("[Flow %s] %s", tag, v.Template)
}

func defaultBody(v alertTplVars) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Cluster: %s\n", v.Cluster)
	fmt.Fprintf(&b, "Run: %s\n", v.RunID)
	if v.StepID != "" {
		fmt.Fprintf(&b, "Step: %s (#%d)\n", v.StepID, v.StepIndex)
	}
	if v.Error != "" {
		fmt.Fprintf(&b, "\nError:\n%s\n", v.Error)
	}
	fmt.Fprintf(&b, "\nAt: %s", v.When)
	return b.String()
}

func defaultSeverityFor(status string) string {
	switch status {
	case "failure":
		return "critical"
	case "await":
		return "warning"
	default:
		return "info"
	}
}
