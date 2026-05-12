package store

import (
	"context"
	"fmt"
)

// Capability is one row in the curated catalog. The name is the stable
// identifier referenced from middleware and frontend; the rest is for
// display in the permissions admin UI.
type Capability struct {
	Name        string `json:"name"`
	Category    string `json:"category"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

// RoleCapability is a row from the role→capability mapping table.
type RoleCapability struct {
	Role       string `json:"role"`
	Capability string `json:"capability"`
}

// ListCapabilities returns the full catalog ordered for stable UI.
func (p *PG) ListCapabilities(ctx context.Context) ([]Capability, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT name, category, label, description
		FROM capabilities
		ORDER BY (category = 'system') ASC, category, name
	`)
	if err != nil {
		return nil, fmt.Errorf("list capabilities: %w", err)
	}
	defer rows.Close()
	var out []Capability
	for rows.Next() {
		var c Capability
		if err := rows.Scan(&c.Name, &c.Category, &c.Label, &c.Description); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ListRoleCapabilities returns every (role, capability) pair currently
// granted.
func (p *PG) ListRoleCapabilities(ctx context.Context) ([]RoleCapability, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT role::text, capability FROM role_capabilities ORDER BY role, capability
	`)
	if err != nil {
		return nil, fmt.Errorf("list role caps: %w", err)
	}
	defer rows.Close()
	var out []RoleCapability
	for rows.Next() {
		var rc RoleCapability
		if err := rows.Scan(&rc.Role, &rc.Capability); err != nil {
			return nil, err
		}
		out = append(out, rc)
	}
	return out, rows.Err()
}

// SetRoleCapabilities replaces the capability set for a single role in
// one transaction. Passing an empty caps slice clears the role's
// permissions entirely; the admin role's wildcard "*" can be removed
// this way, so callers should guard against locking themselves out.
func (p *PG) SetRoleCapabilities(ctx context.Context, role string, caps []string) error {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) // safe even after Commit
	if _, err := tx.Exec(ctx, `DELETE FROM role_capabilities WHERE role = $1::user_role`, role); err != nil {
		return fmt.Errorf("clear role caps: %w", err)
	}
	for _, cap := range caps {
		if _, err := tx.Exec(ctx, `
			INSERT INTO role_capabilities (role, capability) VALUES ($1::user_role, $2)
			ON CONFLICT DO NOTHING
		`, role, cap); err != nil {
			return fmt.Errorf("insert role cap %s/%s: %w", role, cap, err)
		}
	}
	return tx.Commit(ctx)
}
