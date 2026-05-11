package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// OpsTemplate is a reusable sequence of weed shell commands an operator
// can run from the Ops Console. See migrations/pg/021_ops_templates.sql
// for the column layout and the rationale for keeping `steps` as jsonb.
type OpsTemplate struct {
	ID          uuid.UUID       `json:"id"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Category    string          `json:"category"`
	Steps       json.RawMessage `json:"steps"`
	CreatedBy   string          `json:"created_by"`
	UpdatedBy   string          `json:"updated_by"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
}

func (p *PG) ListOpsTemplates(ctx context.Context) ([]OpsTemplate, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT id, name, description, category, steps, created_by, updated_by, created_at, updated_at
		FROM ops_templates ORDER BY category, name`)
	if err != nil {
		return nil, fmt.Errorf("list ops_templates: %w", err)
	}
	defer rows.Close()
	out := []OpsTemplate{}
	for rows.Next() {
		var t OpsTemplate
		if err := rows.Scan(&t.ID, &t.Name, &t.Description, &t.Category, &t.Steps,
			&t.CreatedBy, &t.UpdatedBy, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan ops_template: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (p *PG) GetOpsTemplate(ctx context.Context, id uuid.UUID) (*OpsTemplate, error) {
	var t OpsTemplate
	err := p.Pool.QueryRow(ctx, `
		SELECT id, name, description, category, steps, created_by, updated_by, created_at, updated_at
		FROM ops_templates WHERE id = $1`, id).
		Scan(&t.ID, &t.Name, &t.Description, &t.Category, &t.Steps,
			&t.CreatedBy, &t.UpdatedBy, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("get ops_template: %w", err)
	}
	return &t, nil
}

// UpsertOpsTemplate creates a new template when ID is zero, otherwise
// updates the matching row. The (name) unique index gives us natural
// dedupe by display name regardless of who saved it.
func (p *PG) UpsertOpsTemplate(ctx context.Context, t OpsTemplate, actor string) (uuid.UUID, error) {
	if len(t.Steps) == 0 {
		t.Steps = json.RawMessage(`[]`)
	}
	if t.Category == "" {
		t.Category = "general"
	}
	if t.ID == uuid.Nil {
		err := p.Pool.QueryRow(ctx, `
			INSERT INTO ops_templates (name, description, category, steps, created_by, updated_by)
			VALUES ($1,$2,$3,$4,$5,$5)
			RETURNING id`,
			t.Name, t.Description, t.Category, t.Steps, actor).Scan(&t.ID)
		if err != nil {
			return uuid.Nil, fmt.Errorf("insert ops_template: %w", err)
		}
		return t.ID, nil
	}
	_, err := p.Pool.Exec(ctx, `
		UPDATE ops_templates
		   SET name=$2, description=$3, category=$4, steps=$5,
		       updated_by=$6, updated_at=NOW()
		 WHERE id=$1`,
		t.ID, t.Name, t.Description, t.Category, t.Steps, actor)
	if err != nil {
		return uuid.Nil, fmt.Errorf("update ops_template: %w", err)
	}
	return t.ID, nil
}

func (p *PG) DeleteOpsTemplate(ctx context.Context, id uuid.UUID) error {
	_, err := p.Pool.Exec(ctx, `DELETE FROM ops_templates WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("delete ops_template: %w", err)
	}
	return nil
}
