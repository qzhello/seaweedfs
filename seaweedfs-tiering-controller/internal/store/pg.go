package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PG struct {
	Pool *pgxpool.Pool
}

func NewPG(ctx context.Context, dsn string, maxConns int32) (*PG, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse pg dsn: %w", err)
	}
	if maxConns > 0 {
		cfg.MaxConns = maxConns
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect pg: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("ping pg: %w", err)
	}
	return &PG{Pool: pool}, nil
}

func (p *PG) Close() { p.Pool.Close() }

// ---------------------------- Policies ----------------------------

type Policy struct {
	ID         uuid.UUID       `json:"id"`
	Name       string          `json:"name"`
	ScopeKind  string          `json:"scope_kind"`
	ScopeValue string          `json:"scope_value"`
	Strategy   string          `json:"strategy"`
	Params     json.RawMessage `json:"params"`
	SampleRate float64         `json:"sample_rate"`
	DryRun     bool            `json:"dry_run"`
	Enabled    bool            `json:"enabled"`
	CreatedAt  time.Time       `json:"created_at"`
	UpdatedAt  time.Time       `json:"updated_at"`
}

func (p *PG) ListPolicies(ctx context.Context) ([]Policy, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT id,name,scope_kind,scope_value,strategy,params,sample_rate,dry_run,enabled,created_at,updated_at
		FROM policies ORDER BY created_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list policies: %w", err)
	}
	defer rows.Close()
	out := []Policy{}
	for rows.Next() {
		var x Policy
		if err := rows.Scan(&x.ID, &x.Name, &x.ScopeKind, &x.ScopeValue, &x.Strategy,
			&x.Params, &x.SampleRate, &x.DryRun, &x.Enabled, &x.CreatedAt, &x.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan policy: %w", err)
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

func (p *PG) UpsertPolicy(ctx context.Context, x Policy) (uuid.UUID, error) {
	if x.ID == uuid.Nil {
		x.ID = uuid.New()
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO policies (id,name,scope_kind,scope_value,strategy,params,sample_rate,dry_run,enabled)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT (name) DO UPDATE SET
		  scope_kind=EXCLUDED.scope_kind, scope_value=EXCLUDED.scope_value,
		  strategy=EXCLUDED.strategy,     params=EXCLUDED.params,
		  sample_rate=EXCLUDED.sample_rate, dry_run=EXCLUDED.dry_run,
		  enabled=EXCLUDED.enabled,       updated_at=NOW()`,
		x.ID, x.Name, x.ScopeKind, x.ScopeValue, x.Strategy, x.Params,
		x.SampleRate, x.DryRun, x.Enabled)
	if err != nil {
		return uuid.Nil, fmt.Errorf("upsert policy: %w", err)
	}
	return x.ID, nil
}

// ---------------------------- Tasks -----------------------------

type Task struct {
	ID             uuid.UUID       `json:"id"`
	VolumeID       int32           `json:"volume_id"`
	Collection     string          `json:"collection"`
	SrcServer      string          `json:"src_server"`
	SrcDiskType    string          `json:"src_disk_type"`
	Action         string          `json:"action"`
	Target         json.RawMessage `json:"target"`
	Score          float64         `json:"score"`
	Features       json.RawMessage `json:"features"`
	Explanation    string          `json:"explanation"`
	PolicyID       *uuid.UUID      `json:"policy_id,omitempty"`
	Status         string          `json:"status"`
	IdempotencyKey string          `json:"idempotency_key,omitempty"`
	CreatedAt      time.Time       `json:"created_at"`
	ApprovedAt     *time.Time      `json:"approved_at,omitempty"`
	ApprovedBy     *string         `json:"approved_by,omitempty"`
	ClusterID      *uuid.UUID      `json:"cluster_id,omitempty"`
	AutonomyScore  json.RawMessage `json:"autonomy_score,omitempty"`
}

func (p *PG) InsertTask(ctx context.Context, t Task) (uuid.UUID, error) {
	return p.InsertTaskWithCluster(ctx, t, nil, nil)
}

// InsertTaskWithCluster attaches optional cluster_id + business_domain (added in 002 migration).
// Returns ErrDuplicateTask if an active task with the same idempotency_key exists.
func (p *PG) InsertTaskWithCluster(ctx context.Context, t Task, clusterID *uuid.UUID, businessDomain *string) (uuid.UUID, error) {
	if t.ID == uuid.Nil {
		t.ID = uuid.New()
	}
	var idemp interface{}
	if t.IdempotencyKey != "" {
		idemp = t.IdempotencyKey
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO tasks (id,volume_id,collection,src_server,src_disk_type,action,target,score,features,explanation,policy_id,status,cluster_id,business_domain,idempotency_key)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
		t.ID, t.VolumeID, t.Collection, t.SrcServer, t.SrcDiskType, t.Action,
		t.Target, t.Score, t.Features, t.Explanation, t.PolicyID, t.Status,
		clusterID, businessDomain, idemp)
	if err != nil {
		// Surface unique-constraint violation distinctly so the scheduler can
		// quietly skip rather than log a scary error.
		if strings.Contains(err.Error(), "uniq_active_task_per_volume_action") {
			return uuid.Nil, ErrDuplicateTask
		}
		return uuid.Nil, fmt.Errorf("insert task: %w", err)
	}
	return t.ID, nil
}

// ErrDuplicateTask is returned when InsertTask hits the partial unique index.
var ErrDuplicateTask = fmt.Errorf("duplicate active task for volume/action")

// GetTask returns one task by id. Used by the AI review endpoint.
func (p *PG) GetTask(ctx context.Context, id uuid.UUID) (*Task, error) {
	row := p.Pool.QueryRow(ctx, `
		SELECT id,volume_id,collection,src_server,src_disk_type,action,target,score,features,explanation,policy_id,status,created_at,approved_at,approved_by,cluster_id,autonomy_score
		FROM tasks WHERE id=$1`, id)
	var t Task
	if err := row.Scan(&t.ID, &t.VolumeID, &t.Collection, &t.SrcServer, &t.SrcDiskType,
		&t.Action, &t.Target, &t.Score, &t.Features, &t.Explanation, &t.PolicyID,
		&t.Status, &t.CreatedAt, &t.ApprovedAt, &t.ApprovedBy, &t.ClusterID, &t.AutonomyScore); err != nil {
		return nil, fmt.Errorf("get task: %w", err)
	}
	return &t, nil
}

func (p *PG) ListTasks(ctx context.Context, status string, limit int) ([]Task, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	q := `SELECT id,volume_id,collection,src_server,src_disk_type,action,target,score,features,explanation,policy_id,status,created_at,approved_at,approved_by,cluster_id,autonomy_score
	      FROM tasks`
	args := []any{}
	if status != "" {
		q += ` WHERE status=$1`
		args = append(args, status)
	}
	q += fmt.Sprintf(` ORDER BY created_at DESC LIMIT %d`, limit)
	rows, err := p.Pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("list tasks: %w", err)
	}
	defer rows.Close()
	out := []Task{}
	for rows.Next() {
		var t Task
		if err := rows.Scan(&t.ID, &t.VolumeID, &t.Collection, &t.SrcServer, &t.SrcDiskType,
			&t.Action, &t.Target, &t.Score, &t.Features, &t.Explanation, &t.PolicyID,
			&t.Status, &t.CreatedAt, &t.ApprovedAt, &t.ApprovedBy, &t.ClusterID, &t.AutonomyScore); err != nil {
			return nil, fmt.Errorf("scan task: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (p *PG) UpdateTaskStatus(ctx context.Context, id uuid.UUID, status string, approvedBy string) error {
	if approvedBy != "" {
		_, err := p.Pool.Exec(ctx,
			`UPDATE tasks SET status=$1, approved_at=NOW(), approved_by=$2 WHERE id=$3`,
			status, approvedBy, id)
		if err != nil {
			return fmt.Errorf("update task: %w", err)
		}
		return nil
	}
	_, err := p.Pool.Exec(ctx, `UPDATE tasks SET status=$1 WHERE id=$2`, status, id)
	if err != nil {
		return fmt.Errorf("update task: %w", err)
	}
	return nil
}

// ---------------------------- Executions ----------------------------

type Execution struct {
	ID            uuid.UUID       `json:"id"`
	TaskID        uuid.UUID       `json:"task_id"`
	TraceID       string          `json:"trace_id"`
	StartedAt     time.Time       `json:"started_at"`
	FinishedAt    *time.Time      `json:"finished_at,omitempty"`
	Status        string          `json:"status"`
	RollbackKind  *string         `json:"rollback_kind,omitempty"`
	RollbackArgs  json.RawMessage `json:"rollback_args"`
	Log           string          `json:"log"`
	Error         *string         `json:"error,omitempty"`
	AIPostmortem  json.RawMessage `json:"ai_postmortem,omitempty"`
}

func (p *PG) InsertExecution(ctx context.Context, e Execution) (uuid.UUID, error) {
	if e.ID == uuid.Nil {
		e.ID = uuid.New()
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO executions (id,task_id,trace_id,status,rollback_kind,rollback_args)
		VALUES ($1,$2,$3,$4,$5,$6)`,
		e.ID, e.TaskID, e.TraceID, e.Status, e.RollbackKind, e.RollbackArgs)
	if err != nil {
		return uuid.Nil, fmt.Errorf("insert execution: %w", err)
	}
	return e.ID, nil
}

// UpdateExecutionLog overwrites the log column without touching status. Used
// by the executor to stream partial progress so the UI's 3s poll can render
// running step waterfalls instead of blanking until the task finishes.
func (p *PG) UpdateExecutionLog(ctx context.Context, id uuid.UUID, log string) error {
	_, err := p.Pool.Exec(ctx, `UPDATE executions SET log=$1 WHERE id=$2`, log, id)
	if err != nil {
		return fmt.Errorf("update execution log: %w", err)
	}
	return nil
}

func (p *PG) FinishExecution(ctx context.Context, id uuid.UUID, status, log string, errMsg *string) error {
	_, err := p.Pool.Exec(ctx, `
		UPDATE executions SET status=$1, finished_at=NOW(), log=$2, error=$3 WHERE id=$4`,
		status, log, errMsg, id)
	if err != nil {
		return fmt.Errorf("finish execution: %w", err)
	}
	return nil
}

func (p *PG) GetExecution(ctx context.Context, id uuid.UUID) (*Execution, error) {
	row := p.Pool.QueryRow(ctx, `
		SELECT id,task_id,trace_id,started_at,finished_at,status,rollback_kind,rollback_args,log,error,ai_postmortem
		FROM executions WHERE id=$1`, id)
	var e Execution
	if err := row.Scan(&e.ID, &e.TaskID, &e.TraceID, &e.StartedAt, &e.FinishedAt,
		&e.Status, &e.RollbackKind, &e.RollbackArgs, &e.Log, &e.Error, &e.AIPostmortem); err != nil {
		return nil, fmt.Errorf("get execution: %w", err)
	}
	return &e, nil
}

// SetExecutionPostmortem persists an AI failure-diagnosis JSON onto the
// execution row. Idempotent — called both auto (on failure) and manually
// (when the user re-runs diagnosis from the UI).
func (p *PG) SetExecutionPostmortem(ctx context.Context, id uuid.UUID, postmortem any) error {
	b, err := json.Marshal(postmortem)
	if err != nil {
		return fmt.Errorf("marshal postmortem: %w", err)
	}
	_, err = p.Pool.Exec(ctx, `UPDATE executions SET ai_postmortem=$1 WHERE id=$2`, b, id)
	if err != nil {
		return fmt.Errorf("save postmortem: %w", err)
	}
	return nil
}

// LatestExecutionForTask returns the most recently started execution for a
// task (or nil + nil error if no execution exists). The Tasks UI uses this
// to deep-link "查看进度" → `/executions/<id>` without forcing the operator
// to remember the execution UUID.
func (p *PG) LatestExecutionForTask(ctx context.Context, taskID uuid.UUID) (*Execution, error) {
	row := p.Pool.QueryRow(ctx, `
		SELECT id,task_id,trace_id,started_at,finished_at,status,rollback_kind,rollback_args,log,error,ai_postmortem
		FROM executions WHERE task_id=$1 ORDER BY started_at DESC LIMIT 1`, taskID)
	var e Execution
	if err := row.Scan(&e.ID, &e.TaskID, &e.TraceID, &e.StartedAt, &e.FinishedAt,
		&e.Status, &e.RollbackKind, &e.RollbackArgs, &e.Log, &e.Error, &e.AIPostmortem); err != nil {
		if err.Error() == "no rows in result set" {
			return nil, nil
		}
		return nil, fmt.Errorf("latest execution for task: %w", err)
	}
	return &e, nil
}

// ---------------------------- Cooldown ----------------------------

func (p *PG) InCooldown(ctx context.Context, volumeID int32, days int) (bool, error) {
	row := p.Pool.QueryRow(ctx,
		`SELECT 1 FROM volume_cooldown WHERE volume_id=$1 AND last_at > NOW() - ($2::int * INTERVAL '1 day')`,
		volumeID, days)
	var x int
	switch err := row.Scan(&x); err {
	case nil:
		return true, nil
	default:
		if err.Error() == "no rows in result set" {
			return false, nil
		}
		return false, fmt.Errorf("check cooldown: %w", err)
	}
}

func (p *PG) MarkCooldown(ctx context.Context, volumeID int32, action, reason string) error {
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO volume_cooldown (volume_id,last_action,last_at,reason)
		VALUES ($1,$2,NOW(),$3)
		ON CONFLICT (volume_id) DO UPDATE
		   SET last_action=EXCLUDED.last_action, last_at=EXCLUDED.last_at, reason=EXCLUDED.reason`,
		volumeID, action, reason)
	if err != nil {
		return fmt.Errorf("mark cooldown: %w", err)
	}
	return nil
}

// ---------------------------- Audit ----------------------------

func (p *PG) Audit(ctx context.Context, actor, action, kind, targetID string, payload any) error {
	b, _ := json.Marshal(payload)
	_, err := p.Pool.Exec(ctx,
		`INSERT INTO audit_log (actor,action,target_kind,target_id,payload) VALUES ($1,$2,$3,$4,$5)`,
		actor, action, kind, targetID, b)
	if err != nil {
		return fmt.Errorf("audit: %w", err)
	}
	return nil
}

// AuditEntry is the read-side projection of audit_log. Returned by ListAudit.
type AuditEntry struct {
	ID         int64           `json:"id"`
	At         time.Time       `json:"at"`
	Actor      string          `json:"actor"`
	Action     string          `json:"action"`
	TargetKind string          `json:"target_kind"`
	TargetID   string          `json:"target_id"`
	Payload    json.RawMessage `json:"payload"`
}

// AuditFilter narrows the audit-log read. Empty fields are ignored. Limit is
// clamped to [1, 1000] by the caller.
type AuditFilter struct {
	Actor      string
	Action     string
	TargetKind string
	TargetID   string
	Since      time.Time // zero = no lower bound
	Limit      int
}

// ListAudit returns the most recent audit_log rows matching the filter,
// newest first. Designed for the /audit UI and ad-hoc operator queries.
func (p *PG) ListAudit(ctx context.Context, f AuditFilter) ([]AuditEntry, error) {
	if f.Limit <= 0 || f.Limit > 1000 {
		f.Limit = 200
	}
	// Build dynamic WHERE so we can use the idx_audit_at descending scan when
	// no filters are set. Each placeholder is appended in order.
	q := `SELECT id, at, actor, action, target_kind, target_id, payload FROM audit_log WHERE 1=1`
	args := []any{}
	if f.Actor != "" {
		args = append(args, f.Actor)
		q += fmt.Sprintf(" AND actor = $%d", len(args))
	}
	if f.Action != "" {
		args = append(args, f.Action)
		q += fmt.Sprintf(" AND action = $%d", len(args))
	}
	if f.TargetKind != "" {
		args = append(args, f.TargetKind)
		q += fmt.Sprintf(" AND target_kind = $%d", len(args))
	}
	if f.TargetID != "" {
		args = append(args, f.TargetID)
		q += fmt.Sprintf(" AND target_id = $%d", len(args))
	}
	if !f.Since.IsZero() {
		args = append(args, f.Since)
		q += fmt.Sprintf(" AND at >= $%d", len(args))
	}
	args = append(args, f.Limit)
	q += fmt.Sprintf(" ORDER BY at DESC LIMIT $%d", len(args))

	rows, err := p.Pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("audit list: %w", err)
	}
	defer rows.Close()
	out := []AuditEntry{}
	for rows.Next() {
		var e AuditEntry
		if err := rows.Scan(&e.ID, &e.At, &e.Actor, &e.Action, &e.TargetKind, &e.TargetID, &e.Payload); err != nil {
			return nil, fmt.Errorf("audit scan: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// AuditDistinct returns the unique values of a column for filter dropdowns
// in the UI. Restricted to a safe column allowlist; falls back to error on
// anything else to avoid SQL injection through the column name.
func (p *PG) AuditDistinct(ctx context.Context, column string, limit int) ([]string, error) {
	allow := map[string]bool{"actor": true, "action": true, "target_kind": true}
	if !allow[column] {
		return nil, fmt.Errorf("audit distinct: column %q not allowed", column)
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := p.Pool.Query(ctx,
		fmt.Sprintf(`SELECT DISTINCT %s FROM audit_log ORDER BY 1 LIMIT $1`, column), limit)
	if err != nil {
		return nil, fmt.Errorf("audit distinct: %w", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}
