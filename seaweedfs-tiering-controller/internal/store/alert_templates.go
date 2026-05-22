package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// AlertTemplate is a reusable message template rendered with Go
// text/template syntax. Used by ops-template runs (and potentially
// any other emitter) to produce per-channel notification bodies
// without hard-coding text in Go. Variables exposed at render time
// are defined in api/ops_template_alerts.go (Vars struct).
type AlertTemplate struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	TitleTmpl   string    `json:"title_tmpl"`
	BodyTmpl    string    `json:"body_tmpl"`
	Severity    string    `json:"severity"`
	CreatedBy   string    `json:"created_by"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (p *PG) ListAlertTemplates(ctx context.Context) ([]AlertTemplate, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT id, name, description, title_tmpl, body_tmpl, severity, created_by, created_at, updated_at
		FROM alert_templates ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("list alert_templates: %w", err)
	}
	defer rows.Close()
	out := []AlertTemplate{}
	for rows.Next() {
		var t AlertTemplate
		if err := rows.Scan(&t.ID, &t.Name, &t.Description, &t.TitleTmpl, &t.BodyTmpl,
			&t.Severity, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan alert_template: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (p *PG) GetAlertTemplate(ctx context.Context, id uuid.UUID) (*AlertTemplate, error) {
	var t AlertTemplate
	err := p.Pool.QueryRow(ctx, `
		SELECT id, name, description, title_tmpl, body_tmpl, severity, created_by, created_at, updated_at
		FROM alert_templates WHERE id = $1`, id).
		Scan(&t.ID, &t.Name, &t.Description, &t.TitleTmpl, &t.BodyTmpl,
			&t.Severity, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("get alert_template: %w", err)
	}
	return &t, nil
}

func (p *PG) UpsertAlertTemplate(ctx context.Context, t AlertTemplate, actor string) (uuid.UUID, error) {
	if t.Severity == "" {
		t.Severity = "warning"
	}
	if t.ID == uuid.Nil {
		err := p.Pool.QueryRow(ctx, `
			INSERT INTO alert_templates (name, description, title_tmpl, body_tmpl, severity, created_by)
			VALUES ($1,$2,$3,$4,$5,$6)
			RETURNING id`,
			t.Name, t.Description, t.TitleTmpl, t.BodyTmpl, t.Severity, actor).Scan(&t.ID)
		if err != nil {
			return uuid.Nil, fmt.Errorf("insert alert_template: %w", err)
		}
		return t.ID, nil
	}
	_, err := p.Pool.Exec(ctx, `
		UPDATE alert_templates
		   SET name=$2, description=$3, title_tmpl=$4, body_tmpl=$5, severity=$6, updated_at=NOW()
		 WHERE id=$1`,
		t.ID, t.Name, t.Description, t.TitleTmpl, t.BodyTmpl, t.Severity)
	if err != nil {
		return uuid.Nil, fmt.Errorf("update alert_template: %w", err)
	}
	return t.ID, nil
}

func (p *PG) DeleteAlertTemplate(ctx context.Context, id uuid.UUID) error {
	_, err := p.Pool.Exec(ctx, `DELETE FROM alert_templates WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("delete alert_template: %w", err)
	}
	return nil
}
