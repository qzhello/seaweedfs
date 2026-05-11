package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Skill is the persisted form of one Skill version.
type Skill struct {
	ID         uuid.UUID       `json:"id"`
	Key        string          `json:"key"`
	Name       string          `json:"name"`
	Scope      string          `json:"scope"`
	RiskLevel  string          `json:"risk_level"`
	Category   string          `json:"category"`
	Version    int             `json:"version"`
	Enabled    bool            `json:"enabled"`
	Definition json.RawMessage `json:"definition"`
	ChangeNote string          `json:"change_note,omitempty"`
	CreatedBy  string          `json:"created_by,omitempty"`
	UpdatedBy  string          `json:"updated_by,omitempty"`
	CreatedAt  time.Time       `json:"created_at"`
	UpdatedAt  time.Time       `json:"updated_at"`
}

// ListSkills returns all skills, ordered by category then key, latest version first.
// "scope" filter is optional ("system","custom","" for all).
func (p *PG) ListSkills(ctx context.Context, scope string) ([]Skill, error) {
	q := `SELECT id,key,name,scope,risk_level,category,version,enabled,definition,
		   COALESCE(change_note,''),COALESCE(created_by,''),COALESCE(updated_by,''),
		   created_at,updated_at
		   FROM skills`
	args := []any{}
	if scope != "" {
		q += ` WHERE scope = $1`
		args = append(args, scope)
	}
	q += ` ORDER BY category, key, version DESC`
	rows, err := p.Pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("list skills: %w", err)
	}
	defer rows.Close()
	out := []Skill{}
	for rows.Next() {
		var s Skill
		if err := rows.Scan(&s.ID, &s.Key, &s.Name, &s.Scope, &s.RiskLevel, &s.Category,
			&s.Version, &s.Enabled, &s.Definition, &s.ChangeNote, &s.CreatedBy, &s.UpdatedBy,
			&s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan skill: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// GetSkillCurrent returns the highest enabled version for a key, or pgx.ErrNoRows.
func (p *PG) GetSkillCurrent(ctx context.Context, key string) (*Skill, error) {
	row := p.Pool.QueryRow(ctx, `
		SELECT id,key,name,scope,risk_level,category,version,enabled,definition,
		       COALESCE(change_note,''),COALESCE(created_by,''),COALESCE(updated_by,''),
		       created_at,updated_at
		FROM skills
		WHERE key=$1 AND enabled=TRUE
		ORDER BY version DESC
		LIMIT 1`, key)
	var s Skill
	if err := row.Scan(&s.ID, &s.Key, &s.Name, &s.Scope, &s.RiskLevel, &s.Category,
		&s.Version, &s.Enabled, &s.Definition, &s.ChangeNote, &s.CreatedBy, &s.UpdatedBy,
		&s.CreatedAt, &s.UpdatedAt); err != nil {
		return nil, err
	}
	return &s, nil
}

// UpsertSystemSkill inserts a built-in skill if missing or upgrades it when the
// shipped version is higher than what's stored. It never downgrades operator-
// edited definitions of the same key (those would have scope='custom').
func (p *PG) UpsertSystemSkill(ctx context.Context, s Skill) (upgraded bool, err error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var (
		curID      uuid.UUID
		curVersion int
		curScope   string
	)
	row := tx.QueryRow(ctx, `
		SELECT id,version,scope FROM skills
		WHERE key=$1 ORDER BY version DESC LIMIT 1`, s.Key)
	switch err := row.Scan(&curID, &curVersion, &curScope); err {
	case nil:
		if curScope == "custom" {
			// Operator owns this key now — leave their version alone.
			return false, tx.Commit(ctx)
		}
		if s.Version <= curVersion {
			return false, tx.Commit(ctx)
		}
	case pgx.ErrNoRows:
		// First install — fall through to insert.
	default:
		return false, fmt.Errorf("lookup current: %w", err)
	}

	var newID uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO skills (key,name,scope,risk_level,category,version,enabled,definition,change_note,created_by,updated_by)
		VALUES ($1,$2,'system',$3,$4,$5,TRUE,$6,$7,'system','system')
		RETURNING id`,
		s.Key, s.Name, s.RiskLevel, s.Category, s.Version, s.Definition, s.ChangeNote,
	).Scan(&newID); err != nil {
		return false, fmt.Errorf("insert skill: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO skill_history (skill_id,key,version,definition,change_note,changed_by)
		VALUES ($1,$2,$3,$4,$5,'system')`,
		newID, s.Key, s.Version, s.Definition, s.ChangeNote)
	if err != nil {
		return false, fmt.Errorf("insert skill history: %w", err)
	}
	return true, tx.Commit(ctx)
}

// UpsertCustomSkill creates or updates a custom (operator-defined) skill, always
// bumping version and writing to history.
func (p *PG) UpsertCustomSkill(ctx context.Context, s Skill, actor string) (Skill, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return Skill{}, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var nextVersion int
	row := tx.QueryRow(ctx, `
		SELECT COALESCE(MAX(version),0)+1 FROM skills WHERE key=$1`, s.Key)
	if err := row.Scan(&nextVersion); err != nil {
		return Skill{}, fmt.Errorf("next version: %w", err)
	}

	var saved Skill
	row = tx.QueryRow(ctx, `
		INSERT INTO skills (key,name,scope,risk_level,category,version,enabled,definition,change_note,created_by,updated_by)
		VALUES ($1,$2,'custom',$3,$4,$5,TRUE,$6,$7,$8,$8)
		RETURNING id,key,name,scope,risk_level,category,version,enabled,definition,
		          COALESCE(change_note,''),COALESCE(created_by,''),COALESCE(updated_by,''),
		          created_at,updated_at`,
		s.Key, s.Name, s.RiskLevel, s.Category, nextVersion, s.Definition, s.ChangeNote, actor)
	if err := row.Scan(&saved.ID, &saved.Key, &saved.Name, &saved.Scope, &saved.RiskLevel,
		&saved.Category, &saved.Version, &saved.Enabled, &saved.Definition, &saved.ChangeNote,
		&saved.CreatedBy, &saved.UpdatedBy, &saved.CreatedAt, &saved.UpdatedAt); err != nil {
		return Skill{}, fmt.Errorf("insert custom: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO skill_history (skill_id,key,version,definition,change_note,changed_by)
		VALUES ($1,$2,$3,$4,$5,$6)`,
		saved.ID, saved.Key, saved.Version, saved.Definition, saved.ChangeNote, actor); err != nil {
		return Skill{}, fmt.Errorf("history: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Skill{}, err
	}
	return saved, nil
}

// SetSkillEnabled toggles enabled for the latest version of a skill. Used by
// the Skill store page to disable a built-in without deleting it.
func (p *PG) SetSkillEnabled(ctx context.Context, key string, enabled bool, actor string) error {
	_, err := p.Pool.Exec(ctx, `
		UPDATE skills SET enabled=$1, updated_by=$2, updated_at=now()
		WHERE key=$3 AND version=(SELECT MAX(version) FROM skills WHERE key=$3)`,
		enabled, actor, key)
	if err != nil {
		return fmt.Errorf("toggle skill: %w", err)
	}
	return nil
}

// SkillHistory returns the change log for a key, newest first.
type SkillHistoryRow struct {
	Version    int             `json:"version"`
	Definition json.RawMessage `json:"definition"`
	ChangeNote string          `json:"change_note"`
	ChangedBy  string          `json:"changed_by"`
	ChangedAt  time.Time       `json:"changed_at"`
}

func (p *PG) SkillHistory(ctx context.Context, key string, limit int) ([]SkillHistoryRow, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT version,definition,COALESCE(change_note,''),COALESCE(changed_by,''),changed_at
		FROM skill_history WHERE key=$1 ORDER BY changed_at DESC LIMIT $2`, key, limit)
	if err != nil {
		return nil, fmt.Errorf("skill history: %w", err)
	}
	defer rows.Close()
	out := []SkillHistoryRow{}
	for rows.Next() {
		var r SkillHistoryRow
		if err := rows.Scan(&r.Version, &r.Definition, &r.ChangeNote, &r.ChangedBy, &r.ChangedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// SkillStats summarizes recent execution outcomes for the Skill store page.
type SkillStats struct {
	Key         string  `json:"key"`
	Total7d     int     `json:"total_7d"`
	Succeeded7d int     `json:"succeeded_7d"`
	Failed7d    int     `json:"failed_7d"`
	SuccessRate float64 `json:"success_rate"` // 0..1; 0 if no runs.
	AvgDurMs    int     `json:"avg_duration_ms"`
}

func (p *PG) SkillStatsAll(ctx context.Context) (map[string]SkillStats, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT skill_key,
		       COUNT(*),
		       COUNT(*) FILTER (WHERE outcome='succeeded'),
		       COUNT(*) FILTER (WHERE outcome='failed'),
		       COALESCE(AVG(duration_ms),0)::INT
		FROM skill_executions
		WHERE started_at > now() - interval '7 days'
		GROUP BY skill_key`)
	if err != nil {
		return nil, fmt.Errorf("skill stats: %w", err)
	}
	defer rows.Close()
	out := map[string]SkillStats{}
	for rows.Next() {
		var s SkillStats
		if err := rows.Scan(&s.Key, &s.Total7d, &s.Succeeded7d, &s.Failed7d, &s.AvgDurMs); err != nil {
			return nil, err
		}
		if s.Total7d > 0 {
			s.SuccessRate = float64(s.Succeeded7d) / float64(s.Total7d)
		}
		out[s.Key] = s
	}
	return out, rows.Err()
}

// RecordSkillExecution writes one row to skill_executions. Best-effort — the
// caller logs errors but does not abort the migration on failure.
func (p *PG) RecordSkillExecution(ctx context.Context, skillID uuid.UUID, key string, version int,
	taskID *uuid.UUID, clusterID *uuid.UUID, volumeID *int, outcome string, durMs int, errMsg string) error {
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO skill_executions (skill_id,skill_key,skill_version,task_id,cluster_id,volume_id,outcome,duration_ms,error)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULLIF($9,''))`,
		skillID, key, version, taskID, clusterID, volumeID, outcome, durMs, errMsg)
	if err != nil {
		return fmt.Errorf("record skill execution: %w", err)
	}
	return nil
}
