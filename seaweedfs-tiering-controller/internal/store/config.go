package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// ----------------------------- system_config -----------------------------

type ConfigEntry struct {
	Key         string          `json:"key"`
	Group       string          `json:"group_name"`
	Value       json.RawMessage `json:"value"`
	ValueType   string          `json:"value_type"`
	IsHot       bool            `json:"is_hot"`
	IsSensitive bool            `json:"is_sensitive"`
	Description string          `json:"description"`
	Schema      json.RawMessage `json:"schema"`
	Impact      string          `json:"impact"`
	UpdatedBy   string          `json:"updated_by"`
	UpdatedAt   time.Time       `json:"updated_at"`
	Version     int             `json:"version"`
}

// ListConfig returns every config row. Sensitive values are NOT redacted here —
// the API layer decides what to show based on the caller's role.
func (p *PG) ListConfig(ctx context.Context) ([]ConfigEntry, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT key,group_name,value,value_type,is_hot,is_sensitive,description,schema,impact,updated_by,updated_at,version
		FROM system_config ORDER BY group_name, key`)
	if err != nil {
		return nil, fmt.Errorf("list config: %w", err)
	}
	defer rows.Close()
	out := []ConfigEntry{}
	for rows.Next() {
		var e ConfigEntry
		if err := rows.Scan(&e.Key, &e.Group, &e.Value, &e.ValueType, &e.IsHot, &e.IsSensitive,
			&e.Description, &e.Schema, &e.Impact, &e.UpdatedBy, &e.UpdatedAt, &e.Version); err != nil {
			return nil, fmt.Errorf("scan config: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (p *PG) GetConfig(ctx context.Context, key string) (*ConfigEntry, error) {
	row := p.Pool.QueryRow(ctx, `
		SELECT key,group_name,value,value_type,is_hot,is_sensitive,description,schema,impact,updated_by,updated_at,version
		FROM system_config WHERE key=$1`, key)
	var e ConfigEntry
	if err := row.Scan(&e.Key, &e.Group, &e.Value, &e.ValueType, &e.IsHot, &e.IsSensitive,
		&e.Description, &e.Schema, &e.Impact, &e.UpdatedBy, &e.UpdatedAt, &e.Version); err != nil {
		return nil, fmt.Errorf("get config: %w", err)
	}
	return &e, nil
}

// SetConfig updates a single key. The trigger handles version increment + notify
// + history insert. Caller must pass the *expected* current version for OCC.
func (p *PG) SetConfig(ctx context.Context, key string, value json.RawMessage, expectedVersion int, actor string) error {
	tag, err := p.Pool.Exec(ctx, `
		UPDATE system_config
		   SET value=$1, version=version+1, updated_by=$2, updated_at=NOW()
		 WHERE key=$3 AND version=$4`,
		value, actor, key, expectedVersion)
	if err != nil {
		return fmt.Errorf("update config: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("config %q version mismatch (expected %d) — reload and retry", key, expectedVersion)
	}
	return nil
}

// ConfigHistory returns the change log for a key, newest first.
type ConfigHistoryRow struct {
	ID        int64           `json:"id"`
	Key       string          `json:"key"`
	OldValue  json.RawMessage `json:"old_value"`
	NewValue  json.RawMessage `json:"new_value"`
	Version   int             `json:"version"`
	ChangedBy string          `json:"changed_by"`
	ChangedAt time.Time       `json:"changed_at"`
	Note      string          `json:"note"`
}

func (p *PG) ConfigHistory(ctx context.Context, key string, limit int) ([]ConfigHistoryRow, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := p.Pool.Query(ctx,
		`SELECT id,key,old_value,new_value,version,changed_by,changed_at,note
		 FROM config_history WHERE key=$1 ORDER BY changed_at DESC LIMIT $2`, key, limit)
	if err != nil {
		return nil, fmt.Errorf("config history: %w", err)
	}
	defer rows.Close()
	out := []ConfigHistoryRow{}
	for rows.Next() {
		var h ConfigHistoryRow
		if err := rows.Scan(&h.ID, &h.Key, &h.OldValue, &h.NewValue, &h.Version,
			&h.ChangedBy, &h.ChangedAt, &h.Note); err != nil {
			return nil, fmt.Errorf("scan history: %w", err)
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// RollbackConfig reverts a key to a specific historical version. Implemented as
// a forward update (so it gets a new version + audit trail) using the old value.
func (p *PG) RollbackConfig(ctx context.Context, key string, toHistoryID int64, actor string) error {
	row := p.Pool.QueryRow(ctx,
		`SELECT new_value FROM config_history WHERE id=$1 AND key=$2`, toHistoryID, key)
	var v json.RawMessage
	if err := row.Scan(&v); err != nil {
		return fmt.Errorf("find history: %w", err)
	}
	_, err := p.Pool.Exec(ctx,
		`UPDATE system_config SET value=$1, version=version+1, updated_by=$2, updated_at=NOW() WHERE key=$3`,
		v, actor+" (rollback)", key)
	if err != nil {
		return fmt.Errorf("rollback update: %w", err)
	}
	return nil
}
