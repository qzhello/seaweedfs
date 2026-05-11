package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// ----------------------------- Blocklist -----------------------------

type Blocklist struct {
	ID         uuid.UUID  `json:"id"`
	ScopeKind  string     `json:"scope_kind"`
	ScopeValue string     `json:"scope_value"`
	Actions    []string   `json:"actions"`
	Mode       string     `json:"mode"`
	Reason     string     `json:"reason"`
	CreatedBy  string     `json:"created_by"`
	ExpiresAt  *time.Time `json:"expires_at,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
}

func (p *PG) ListBlocklist(ctx context.Context) ([]Blocklist, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT id,scope_kind,scope_value,actions,mode,reason,created_by,expires_at,created_at
		FROM migration_blocklist
		WHERE expires_at IS NULL OR expires_at > NOW()
		ORDER BY scope_kind, scope_value`)
	if err != nil {
		return nil, fmt.Errorf("list blocklist: %w", err)
	}
	defer rows.Close()
	out := []Blocklist{}
	for rows.Next() {
		var b Blocklist
		if err := rows.Scan(&b.ID, &b.ScopeKind, &b.ScopeValue, &b.Actions, &b.Mode,
			&b.Reason, &b.CreatedBy, &b.ExpiresAt, &b.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan blocklist: %w", err)
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (p *PG) UpsertBlocklist(ctx context.Context, b Blocklist) (uuid.UUID, error) {
	if b.ID == uuid.Nil {
		b.ID = uuid.New()
	}
	if b.Mode == "" {
		b.Mode = "deny"
	}
	if b.Actions == nil {
		b.Actions = []string{}
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO migration_blocklist (id,scope_kind,scope_value,actions,mode,reason,created_by,expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (scope_kind, scope_value) DO UPDATE SET
		  actions=EXCLUDED.actions, mode=EXCLUDED.mode,
		  reason=EXCLUDED.reason, expires_at=EXCLUDED.expires_at`,
		b.ID, b.ScopeKind, b.ScopeValue, b.Actions, b.Mode,
		b.Reason, b.CreatedBy, b.ExpiresAt)
	if err != nil {
		return uuid.Nil, fmt.Errorf("upsert blocklist: %w", err)
	}
	return b.ID, nil
}

func (p *PG) DeleteBlocklist(ctx context.Context, id uuid.UUID) error {
	_, err := p.Pool.Exec(ctx, `DELETE FROM migration_blocklist WHERE id=$1`, id)
	if err != nil {
		return fmt.Errorf("delete blocklist: %w", err)
	}
	return nil
}

// CheckBlocklist returns the blocking entry name (or empty) when the given
// migration target is denied. Caller passes whichever attributes apply.
func (p *PG) CheckBlocklist(ctx context.Context,
	cluster, collection, bucket string, volumeID int32, action string) (blockedBy string, err error) {

	rows, err := p.Pool.Query(ctx, `
		SELECT scope_kind, scope_value, actions
		FROM migration_blocklist
		WHERE mode='deny' AND (expires_at IS NULL OR expires_at > NOW())`)
	if err != nil {
		return "", fmt.Errorf("query blocklist: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var kind, value string
		var actions []string
		if err := rows.Scan(&kind, &value, &actions); err != nil {
			return "", fmt.Errorf("scan blocklist row: %w", err)
		}
		var attr string
		switch kind {
		case "cluster":
			attr = cluster
		case "collection":
			attr = collection
		case "bucket":
			attr = bucket
		case "volume_id":
			attr = fmt.Sprintf("%d", volumeID)
		}
		if !globMatch(value, attr) {
			continue
		}
		if len(actions) == 0 || containsString(actions, action) {
			return fmt.Sprintf("%s=%s", kind, value), nil
		}
	}
	return "", rows.Err()
}

// globMatch supports leading/trailing '*' only — keeps it cheap and predictable.
func globMatch(pattern, s string) bool {
	if pattern == "*" || pattern == s {
		return true
	}
	star := false
	if len(pattern) > 0 && pattern[0] == '*' {
		pattern = pattern[1:]
		star = true
	}
	if len(pattern) > 0 && pattern[len(pattern)-1] == '*' {
		pattern = pattern[:len(pattern)-1]
		// suffix wildcard
		return startsWith(s, pattern)
	}
	if star {
		return endsWith(s, pattern)
	}
	return pattern == s
}

func startsWith(s, p string) bool { return len(s) >= len(p) && s[:len(p)] == p }
func endsWith(s, p string) bool   { return len(s) >= len(p) && s[len(s)-len(p):] == p }

func containsString(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// ----------------------------- Maintenance -----------------------------

type MaintenanceWindow struct {
	ID        uuid.UUID  `json:"id"`
	ClusterID *uuid.UUID `json:"cluster_id,omitempty"`
	Name      string     `json:"name"`
	StartsAt  time.Time  `json:"starts_at"`
	EndsAt    time.Time  `json:"ends_at"`
	Reason    string     `json:"reason"`
	CreatedBy string     `json:"created_by"`
	CreatedAt time.Time  `json:"created_at"`
}

func (p *PG) ListMaintenanceWindows(ctx context.Context, includePast bool) ([]MaintenanceWindow, error) {
	q := `SELECT id,cluster_id,name,starts_at,ends_at,reason,created_by,created_at FROM maintenance_windows`
	if !includePast {
		q += ` WHERE ends_at >= NOW()`
	}
	q += ` ORDER BY starts_at`
	rows, err := p.Pool.Query(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("list maintenance windows: %w", err)
	}
	defer rows.Close()
	out := []MaintenanceWindow{}
	for rows.Next() {
		var m MaintenanceWindow
		if err := rows.Scan(&m.ID, &m.ClusterID, &m.Name, &m.StartsAt, &m.EndsAt,
			&m.Reason, &m.CreatedBy, &m.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan maintenance: %w", err)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (p *PG) UpsertMaintenanceWindow(ctx context.Context, m MaintenanceWindow) (uuid.UUID, error) {
	if m.ID == uuid.Nil {
		m.ID = uuid.New()
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO maintenance_windows (id,cluster_id,name,starts_at,ends_at,reason,created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (id) DO UPDATE SET
		  cluster_id=EXCLUDED.cluster_id, name=EXCLUDED.name,
		  starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at,
		  reason=EXCLUDED.reason`,
		m.ID, m.ClusterID, m.Name, m.StartsAt, m.EndsAt, m.Reason, m.CreatedBy)
	if err != nil {
		return uuid.Nil, fmt.Errorf("upsert maintenance window: %w", err)
	}
	return m.ID, nil
}

func (p *PG) DeleteMaintenanceWindow(ctx context.Context, id uuid.UUID) error {
	_, err := p.Pool.Exec(ctx, `DELETE FROM maintenance_windows WHERE id=$1`, id)
	if err != nil {
		return fmt.Errorf("delete maintenance window: %w", err)
	}
	return nil
}

// ActiveMaintenance returns the first currently-active window matching
// (cluster_id OR global) — caller treats any match as a halt.
func (p *PG) ActiveMaintenance(ctx context.Context, clusterID *uuid.UUID) (*MaintenanceWindow, error) {
	row := p.Pool.QueryRow(ctx, `
		SELECT id,cluster_id,name,starts_at,ends_at,reason,created_by,created_at
		FROM maintenance_windows
		WHERE NOW() BETWEEN starts_at AND ends_at
		  AND (cluster_id IS NULL OR cluster_id = $1)
		ORDER BY starts_at LIMIT 1`, clusterID)
	var m MaintenanceWindow
	switch err := row.Scan(&m.ID, &m.ClusterID, &m.Name, &m.StartsAt, &m.EndsAt,
		&m.Reason, &m.CreatedBy, &m.CreatedAt); err {
	case nil:
		return &m, nil
	default:
		if err.Error() == "no rows in result set" {
			return nil, nil
		}
		return nil, fmt.Errorf("active maintenance: %w", err)
	}
}
