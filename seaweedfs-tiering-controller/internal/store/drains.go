package store

// VolumeServerDrain — persistent record of a drain job. Lifecycle is
// driven by the api/drains.go runner; this file is just the SQL
// boundary.

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

type VolumeServerDrain struct {
	ID             uuid.UUID  `json:"id"`
	ClusterID      uuid.UUID  `json:"cluster_id"`
	Node           string     `json:"node"`
	Status         string     `json:"status"` // pending|running|verifying|done|failed|cancelled
	Force          bool       `json:"force"`
	Reason         string     `json:"reason"`
	RequestedBy    string     `json:"requested_by"`
	InitialVolumes int        `json:"initial_volumes"`
	InitialBytes   int64      `json:"initial_bytes"`
	LastVolumes    int        `json:"last_volumes"`
	LastBytes      int64      `json:"last_bytes"`
	Attempts       int        `json:"attempts"`
	RunLog         string     `json:"run_log"`
	Error          string     `json:"error"`
	CreatedAt      time.Time  `json:"created_at"`
	StartedAt      *time.Time `json:"started_at,omitempty"`
	FinishedAt     *time.Time `json:"finished_at,omitempty"`
}

const drainCols = `id, cluster_id, node, status, force, reason, requested_by,
    initial_volumes, initial_bytes, last_volumes, last_bytes,
    attempts, run_log, error, created_at, started_at, finished_at`

// CreateDrain inserts a new drain job in the `pending` state and
// returns its assigned id. Initial volume/bytes counts are taken at
// request time so the dashboard can show "% drained" honestly.
func (p *PG) CreateDrain(ctx context.Context, d VolumeServerDrain) (uuid.UUID, error) {
	if d.ID == uuid.Nil {
		d.ID = uuid.New()
	}
	if d.Status == "" {
		d.Status = "pending"
	}
	_, err := p.Pool.Exec(ctx, `
        INSERT INTO volume_server_drains
            (id, cluster_id, node, status, force, reason, requested_by,
             initial_volumes, initial_bytes, last_volumes, last_bytes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		d.ID, d.ClusterID, d.Node, d.Status, d.Force, d.Reason, d.RequestedBy,
		d.InitialVolumes, d.InitialBytes, d.InitialVolumes, d.InitialBytes)
	if err != nil {
		return uuid.Nil, fmt.Errorf("insert drain: %w", err)
	}
	return d.ID, nil
}

func (p *PG) GetDrain(ctx context.Context, id uuid.UUID) (*VolumeServerDrain, error) {
	row := p.Pool.QueryRow(ctx, `SELECT `+drainCols+` FROM volume_server_drains WHERE id=$1`, id)
	return scanDrain(row)
}

// ListDrains returns the most recent drain rows, optionally filtered
// by cluster and/or status set. `limit` caps the response; 0 means
// "use a sensible default".
func (p *PG) ListDrains(ctx context.Context, clusterID *uuid.UUID, statuses []string, limit int) ([]VolumeServerDrain, error) {
	if limit <= 0 {
		limit = 100
	}
	where := []string{"1=1"}
	args := []any{}
	i := 1
	if clusterID != nil {
		where = append(where, fmt.Sprintf("cluster_id = $%d", i))
		args = append(args, *clusterID)
		i++
	}
	if len(statuses) > 0 {
		// Use ANY($i) to keep the query plan stable regardless of
		// the status set size; pg can index-scan the active partial
		// index for the hot path (status IN active).
		where = append(where, fmt.Sprintf("status = ANY($%d)", i))
		args = append(args, statuses)
		i++
	}
	args = append(args, limit)
	q := `SELECT ` + drainCols + ` FROM volume_server_drains WHERE ` +
		strings.Join(where, " AND ") +
		fmt.Sprintf(" ORDER BY created_at DESC LIMIT $%d", i)
	rows, err := p.Pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("list drains: %w", err)
	}
	defer rows.Close()
	out := []VolumeServerDrain{}
	for rows.Next() {
		d, err := scanDrain(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

// UpdateDrainStatus moves the row to a new status and appends to the
// run log. `setStarted` / `setFinished` toggles the corresponding
// timestamps when non-nil. Pass empty `errMsg` to leave the error
// column untouched, or "-" to explicitly clear it (rare).
func (p *PG) UpdateDrainStatus(ctx context.Context, id uuid.UUID,
	status string, appendLog string, errMsg string,
	setStarted, setFinished bool) error {
	parts := []string{"status = $2"}
	args := []any{id, status}
	i := 3
	if appendLog != "" {
		parts = append(parts, fmt.Sprintf("run_log = run_log || $%d", i))
		args = append(args, appendLog)
		i++
	}
	if errMsg == "-" {
		parts = append(parts, "error = ''")
	} else if errMsg != "" {
		parts = append(parts, fmt.Sprintf("error = $%d", i))
		args = append(args, errMsg)
		i++
	}
	if setStarted {
		parts = append(parts, "started_at = COALESCE(started_at, now())")
		parts = append(parts, "attempts = attempts + 1")
	}
	if setFinished {
		parts = append(parts, "finished_at = now()")
	}
	q := `UPDATE volume_server_drains SET ` + strings.Join(parts, ", ") + ` WHERE id = $1`
	_, err := p.Pool.Exec(ctx, q, args...)
	if err != nil {
		return fmt.Errorf("update drain: %w", err)
	}
	return nil
}

// UpdateDrainProgress refreshes the live volume/byte snapshot during
// verification. Separate from UpdateDrainStatus so the runner can poll
// without rewriting the log.
func (p *PG) UpdateDrainProgress(ctx context.Context, id uuid.UUID, volumes int, bytes int64) error {
	_, err := p.Pool.Exec(ctx,
		`UPDATE volume_server_drains SET last_volumes=$2, last_bytes=$3 WHERE id=$1`,
		id, volumes, bytes)
	if err != nil {
		return fmt.Errorf("update drain progress: %w", err)
	}
	return nil
}

// ResetStaleDrains marks any rows left running/verifying as failed.
// Called on orchestrator startup so a crash mid-drain doesn't leave a
// permanent "running" ghost on the dashboard.
func (p *PG) ResetStaleDrains(ctx context.Context) (int, error) {
	tag, err := p.Pool.Exec(ctx, `
        UPDATE volume_server_drains
           SET status = 'failed',
               error  = COALESCE(NULLIF(error,''), 'orchestrator restarted before completion'),
               finished_at = COALESCE(finished_at, now())
         WHERE status IN ('pending', 'running', 'verifying')`)
	if err != nil {
		return 0, fmt.Errorf("reset stale drains: %w", err)
	}
	return int(tag.RowsAffected()), nil
}

// rowScanner abstracts pgx.Row and pgx.Rows for shared scan helpers.
type rowScanner interface {
	Scan(...any) error
}

func scanDrain(r rowScanner) (*VolumeServerDrain, error) {
	var d VolumeServerDrain
	if err := r.Scan(
		&d.ID, &d.ClusterID, &d.Node, &d.Status, &d.Force, &d.Reason, &d.RequestedBy,
		&d.InitialVolumes, &d.InitialBytes, &d.LastVolumes, &d.LastBytes,
		&d.Attempts, &d.RunLog, &d.Error, &d.CreatedAt, &d.StartedAt, &d.FinishedAt,
	); err != nil {
		return nil, fmt.Errorf("scan drain: %w", err)
	}
	return &d, nil
}
