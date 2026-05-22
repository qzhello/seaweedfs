package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// AnalyzerScript is a deterministic Python post-processor for shell
// command output. See migrations/pg/033_analyzer_scripts.sql for
// column-level docs.
type AnalyzerScript struct {
	ID           uuid.UUID       `json:"id"`
	Name         string          `json:"name"`
	Title        string          `json:"title"`
	Description  string          `json:"description"`
	ForCommands  []string        `json:"for_commands"`
	Tags         []string        `json:"tags"`
	Params       json.RawMessage `json:"params"`
	Body         string          `json:"body"`
	SampleInput  string          `json:"sample_input"`
	SampleOutput json.RawMessage `json:"sample_output,omitempty"`
	Enabled      bool            `json:"enabled"`
	Origin       string          `json:"origin"`
	Version      int             `json:"version"`
	CreatedBy    string          `json:"created_by"`
	UpdatedBy    string          `json:"updated_by"`
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
}

const analyzerCols = `id, name, title, description, for_commands, tags, params, body,
	sample_input, sample_output, enabled, origin, version, created_by, updated_by, created_at, updated_at`

func scanAnalyzer(row interface {
	Scan(dst ...any) error
}, s *AnalyzerScript) error {
	return row.Scan(&s.ID, &s.Name, &s.Title, &s.Description, &s.ForCommands, &s.Tags,
		&s.Params, &s.Body, &s.SampleInput, &s.SampleOutput, &s.Enabled, &s.Origin,
		&s.Version, &s.CreatedBy, &s.UpdatedBy, &s.CreatedAt, &s.UpdatedAt)
}

func (p *PG) ListAnalyzerScripts(ctx context.Context) ([]AnalyzerScript, error) {
	rows, err := p.Pool.Query(ctx,
		`SELECT `+analyzerCols+` FROM analyzer_scripts ORDER BY origin DESC, name`)
	if err != nil {
		return nil, fmt.Errorf("list analyzer_scripts: %w", err)
	}
	defer rows.Close()
	out := []AnalyzerScript{}
	for rows.Next() {
		var s AnalyzerScript
		if err := scanAnalyzer(rows, &s); err != nil {
			return nil, fmt.Errorf("scan analyzer_script: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (p *PG) GetAnalyzerScript(ctx context.Context, id uuid.UUID) (*AnalyzerScript, error) {
	var s AnalyzerScript
	err := scanAnalyzer(p.Pool.QueryRow(ctx,
		`SELECT `+analyzerCols+` FROM analyzer_scripts WHERE id=$1`, id), &s)
	if err != nil {
		return nil, fmt.Errorf("get analyzer_script: %w", err)
	}
	return &s, nil
}

// GetAnalyzerScriptByName resolves by stable name — used by the ops
// template runner so saved templates survive UUID churn during
// reseed.
func (p *PG) GetAnalyzerScriptByName(ctx context.Context, name string) (*AnalyzerScript, error) {
	var s AnalyzerScript
	err := scanAnalyzer(p.Pool.QueryRow(ctx,
		`SELECT `+analyzerCols+` FROM analyzer_scripts WHERE name=$1`, name), &s)
	if err != nil {
		return nil, fmt.Errorf("get analyzer_script by name: %w", err)
	}
	return &s, nil
}

// UpsertAnalyzerScript inserts or updates a script. On UPDATE the
// version counter is bumped and the previous row body is captured
// into analyzer_script_versions for diff/revert. Pass a non-empty
// `reason` to label why the version was bumped (defaults to
// "user-edit").
func (p *PG) UpsertAnalyzerScript(ctx context.Context, s AnalyzerScript, actor string, reason string) (uuid.UUID, error) {
	if len(s.Params) == 0 {
		s.Params = json.RawMessage(`[]`)
	}
	if s.Origin == "" {
		s.Origin = "user"
	}
	if reason == "" {
		reason = "user-edit"
	}
	if s.ID == uuid.Nil {
		err := p.Pool.QueryRow(ctx, `
			INSERT INTO analyzer_scripts
			  (name, title, description, for_commands, tags, params, body,
			   sample_input, sample_output, enabled, origin, version, created_by, updated_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,$12)
			RETURNING id`,
			s.Name, s.Title, s.Description, s.ForCommands, s.Tags, s.Params, s.Body,
			s.SampleInput, nullableJSON(s.SampleOutput), s.Enabled, s.Origin, actor,
		).Scan(&s.ID)
		if err != nil {
			return uuid.Nil, fmt.Errorf("insert analyzer_script: %w", err)
		}
		// Seed v1 in the history table.
		_, _ = p.Pool.Exec(ctx, `
			INSERT INTO analyzer_script_versions (script_id, version, title, description, body, params, reason, actor)
			VALUES ($1, 1, $2, $3, $4, $5, $6, $7)`,
			s.ID, s.Title, s.Description, s.Body, s.Params, "initial", actor)
		return s.ID, nil
	}
	// Snapshot the current row BEFORE the update so the history
	// row reflects what was overwritten, not the new value.
	var nextVer int
	err := p.Pool.QueryRow(ctx, `
		WITH cur AS (
		  SELECT version FROM analyzer_scripts WHERE id=$1
		)
		UPDATE analyzer_scripts
		   SET name=$2, title=$3, description=$4, for_commands=$5, tags=$6,
		       params=$7, body=$8, sample_input=$9, sample_output=$10,
		       enabled=$11, version=(SELECT version FROM cur)+1,
		       updated_by=$12, updated_at=NOW()
		 WHERE id=$1
		 RETURNING version`,
		s.ID, s.Name, s.Title, s.Description, s.ForCommands, s.Tags, s.Params, s.Body,
		s.SampleInput, nullableJSON(s.SampleOutput), s.Enabled, actor).Scan(&nextVer)
	if err != nil {
		return uuid.Nil, fmt.Errorf("update analyzer_script: %w", err)
	}
	_, _ = p.Pool.Exec(ctx, `
		INSERT INTO analyzer_script_versions (script_id, version, title, description, body, params, reason, actor)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		s.ID, nextVer, s.Title, s.Description, s.Body, s.Params, reason, actor)
	return s.ID, nil
}

// AnalyzerScriptVersion is one historical revision.
type AnalyzerScriptVersion struct {
	ID          int64           `json:"id"`
	ScriptID    uuid.UUID       `json:"script_id"`
	Version     int             `json:"version"`
	Title       string          `json:"title"`
	Description string          `json:"description"`
	Body        string          `json:"body"`
	Params      json.RawMessage `json:"params"`
	Reason      string          `json:"reason"`
	Actor       string          `json:"actor"`
	At          time.Time       `json:"at"`
}

func (p *PG) ListAnalyzerScriptVersions(ctx context.Context, scriptID uuid.UUID, limit int) ([]AnalyzerScriptVersion, error) {
	if limit <= 0 || limit > 200 {
		limit = 30
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT id, script_id, version, title, description, body, params, reason, actor, at
		  FROM analyzer_script_versions
		 WHERE script_id=$1
		 ORDER BY version DESC
		 LIMIT $2`, scriptID, limit)
	if err != nil {
		return nil, fmt.Errorf("list analyzer_versions: %w", err)
	}
	defer rows.Close()
	out := []AnalyzerScriptVersion{}
	for rows.Next() {
		var v AnalyzerScriptVersion
		if err := rows.Scan(&v.ID, &v.ScriptID, &v.Version, &v.Title, &v.Description,
			&v.Body, &v.Params, &v.Reason, &v.Actor, &v.At); err != nil {
			return nil, fmt.Errorf("scan analyzer_version: %w", err)
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (p *PG) GetAnalyzerScriptVersion(ctx context.Context, scriptID uuid.UUID, version int) (*AnalyzerScriptVersion, error) {
	var v AnalyzerScriptVersion
	err := p.Pool.QueryRow(ctx, `
		SELECT id, script_id, version, title, description, body, params, reason, actor, at
		  FROM analyzer_script_versions WHERE script_id=$1 AND version=$2`,
		scriptID, version).
		Scan(&v.ID, &v.ScriptID, &v.Version, &v.Title, &v.Description, &v.Body,
			&v.Params, &v.Reason, &v.Actor, &v.At)
	if err != nil {
		return nil, fmt.Errorf("get analyzer_version: %w", err)
	}
	return &v, nil
}

func (p *PG) DeleteAnalyzerScript(ctx context.Context, id uuid.UUID) error {
	_, err := p.Pool.Exec(ctx, `DELETE FROM analyzer_scripts WHERE id=$1`, id)
	if err != nil {
		return fmt.Errorf("delete analyzer_script: %w", err)
	}
	return nil
}

// AnalyzerRun is one execution record. The full output is JSONB so
// follow-up queries (latest run, average elapsed) stay cheap.
type AnalyzerRun struct {
	ID        int64           `json:"id"`
	ScriptID  uuid.UUID       `json:"script_id"`
	Actor     string          `json:"actor"`
	Params    json.RawMessage `json:"params"`
	InputHash string          `json:"input_hash"`
	InputSize int             `json:"input_size"`
	OK        bool            `json:"ok"`
	Error     string          `json:"error"`
	Output    json.RawMessage `json:"output,omitempty"`
	ElapsedMs int             `json:"elapsed_ms"`
	At        time.Time       `json:"at"`
}

func (p *PG) InsertAnalyzerRun(ctx context.Context, r AnalyzerRun) (int64, error) {
	var id int64
	err := p.Pool.QueryRow(ctx, `
		INSERT INTO analyzer_runs
		  (script_id, actor, params, input_hash, input_size, ok, error, output, elapsed_ms)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		RETURNING id`,
		r.ScriptID, r.Actor, r.Params, r.InputHash, r.InputSize,
		r.OK, r.Error, nullableJSON(r.Output), r.ElapsedMs,
	).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("insert analyzer_run: %w", err)
	}
	return id, nil
}

func (p *PG) RecentAnalyzerRuns(ctx context.Context, scriptID uuid.UUID, limit int) ([]AnalyzerRun, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT id, script_id, actor, params, input_hash, input_size, ok, error,
		       output, elapsed_ms, at
		  FROM analyzer_runs
		 WHERE script_id=$1
		 ORDER BY at DESC
		 LIMIT $2`, scriptID, limit)
	if err != nil {
		return nil, fmt.Errorf("list analyzer_runs: %w", err)
	}
	defer rows.Close()
	out := []AnalyzerRun{}
	for rows.Next() {
		var r AnalyzerRun
		if err := rows.Scan(&r.ID, &r.ScriptID, &r.Actor, &r.Params, &r.InputHash,
			&r.InputSize, &r.OK, &r.Error, &r.Output, &r.ElapsedMs, &r.At); err != nil {
			return nil, fmt.Errorf("scan analyzer_run: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
