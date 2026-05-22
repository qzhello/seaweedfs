package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// CapacityIncident is the closed-loop record for a cluster that hit a
// capacity wall. While one is open the scheduler holds tiering for that
// cluster (see ClustersWithOpenIncident). See migration 038.
type CapacityIncident struct {
	ID             uuid.UUID       `json:"id"`
	ClusterID      uuid.UUID       `json:"cluster_id"`
	Status         string          `json:"status"` // open | resolved
	TriggerTaskID  *uuid.UUID      `json:"trigger_task_id,omitempty"`
	FailureMessage string          `json:"failure_message"`
	AIReport       json.RawMessage `json:"ai_report,omitempty"` // nil until analysed
	TriggeredAt    time.Time       `json:"triggered_at"`
	ResolvedAt     *time.Time      `json:"resolved_at,omitempty"`
	ResolvedBy     *string         `json:"resolved_by,omitempty"`
	ClusterName    string          `json:"cluster_name"` // joined, not a column
}

// capacityIncidentCols is the shared 10-column projection. The LEFT JOIN
// keeps the row even if the cluster vanished mid-flight (ON DELETE
// CASCADE makes that effectively impossible, but COALESCE is cheap).
const capacityIncidentCols = `
	ci.id, ci.cluster_id, ci.status, ci.trigger_task_id, ci.failure_message,
	ci.ai_report, ci.triggered_at, ci.resolved_at, ci.resolved_by,
	COALESCE(cl.name, '')`

func scanCapacityIncident(s interface{ Scan(dest ...any) error }) (CapacityIncident, error) {
	var inc CapacityIncident
	err := s.Scan(&inc.ID, &inc.ClusterID, &inc.Status, &inc.TriggerTaskID,
		&inc.FailureMessage, &inc.AIReport, &inc.TriggeredAt, &inc.ResolvedAt,
		&inc.ResolvedBy, &inc.ClusterName)
	return inc, err
}

// OpenCapacityIncident opens an incident for a cluster, or returns the
// already-open one. The partial unique index (one open per cluster)
// makes a repeat capacity failure a no-op INSERT — `created` reports
// whether this call was the one that opened it.
func (p *PG) OpenCapacityIncident(ctx context.Context, clusterID uuid.UUID, triggerTaskID *uuid.UUID, failureMsg string) (*CapacityIncident, bool, error) {
	tag, err := p.Pool.Exec(ctx, `
		INSERT INTO capacity_incidents (cluster_id, trigger_task_id, failure_message)
		VALUES ($1, $2, $3)
		ON CONFLICT (cluster_id) WHERE status = 'open' DO NOTHING`,
		clusterID, triggerTaskID, failureMsg)
	if err != nil {
		return nil, false, fmt.Errorf("open capacity incident: %w", err)
	}
	created := tag.RowsAffected() > 0
	inc, err := p.OpenIncidentForCluster(ctx, clusterID)
	if err != nil {
		return nil, false, err
	}
	return inc, created, nil
}

// OpenIncidentForCluster returns the open incident for a cluster, or
// (nil, nil) when the cluster currently has none.
func (p *PG) OpenIncidentForCluster(ctx context.Context, clusterID uuid.UUID) (*CapacityIncident, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT `+capacityIncidentCols+`
		FROM capacity_incidents ci
		LEFT JOIN clusters cl ON cl.id = ci.cluster_id
		WHERE ci.cluster_id = $1 AND ci.status = 'open'
		ORDER BY ci.triggered_at DESC
		LIMIT 1`, clusterID)
	if err != nil {
		return nil, fmt.Errorf("open incident for cluster: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	inc, err := scanCapacityIncident(rows)
	if err != nil {
		return nil, fmt.Errorf("scan capacity incident: %w", err)
	}
	return &inc, nil
}

// ClustersWithOpenIncident returns the set of cluster IDs currently
// under a capacity hold — the scheduler consults this every pass.
func (p *PG) ClustersWithOpenIncident(ctx context.Context) (map[uuid.UUID]bool, error) {
	rows, err := p.Pool.Query(ctx,
		`SELECT cluster_id FROM capacity_incidents WHERE status = 'open'`)
	if err != nil {
		return nil, fmt.Errorf("list capacity holds: %w", err)
	}
	defer rows.Close()
	held := map[uuid.UUID]bool{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan capacity hold: %w", err)
		}
		held[id] = true
	}
	return held, rows.Err()
}

// ListCapacityIncidents returns incidents, newest first. status may be
// "open", "resolved", or "" for all.
func (p *PG) ListCapacityIncidents(ctx context.Context, status string, limit int) ([]CapacityIncident, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	q := `SELECT ` + capacityIncidentCols + `
		FROM capacity_incidents ci
		LEFT JOIN clusters cl ON cl.id = ci.cluster_id`
	args := []any{}
	if status != "" {
		q += ` WHERE ci.status = $1`
		args = append(args, status)
	}
	q += fmt.Sprintf(` ORDER BY ci.triggered_at DESC LIMIT %d`, limit)
	rows, err := p.Pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("list capacity incidents: %w", err)
	}
	defer rows.Close()
	out := []CapacityIncident{}
	for rows.Next() {
		inc, err := scanCapacityIncident(rows)
		if err != nil {
			return nil, fmt.Errorf("scan capacity incident: %w", err)
		}
		out = append(out, inc)
	}
	return out, rows.Err()
}

// GetCapacityIncident fetches one incident by id.
func (p *PG) GetCapacityIncident(ctx context.Context, id uuid.UUID) (*CapacityIncident, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT `+capacityIncidentCols+`
		FROM capacity_incidents ci
		LEFT JOIN clusters cl ON cl.id = ci.cluster_id
		WHERE ci.id = $1`, id)
	if err != nil {
		return nil, fmt.Errorf("get capacity incident: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if rerr := rows.Err(); rerr != nil {
			return nil, rerr
		}
		return nil, fmt.Errorf("capacity incident not found")
	}
	inc, err := scanCapacityIncident(rows)
	if err != nil {
		return nil, fmt.Errorf("scan capacity incident: %w", err)
	}
	return &inc, nil
}

// SetIncidentAIReport persists the AI analyst brief onto an incident.
func (p *PG) SetIncidentAIReport(ctx context.Context, id uuid.UUID, report any) error {
	b, err := json.Marshal(report)
	if err != nil {
		return fmt.Errorf("marshal incident report: %w", err)
	}
	if _, err := p.Pool.Exec(ctx,
		`UPDATE capacity_incidents SET ai_report = $1 WHERE id = $2`, b, id); err != nil {
		return fmt.Errorf("set incident report: %w", err)
	}
	return nil
}

// ResolveCapacityIncident closes an incident, lifting the capacity hold
// so the scheduler resumes tiering for that cluster on the next pass.
// Returns an error if the incident is not currently open.
func (p *PG) ResolveCapacityIncident(ctx context.Context, id uuid.UUID, resolvedBy string) error {
	tag, err := p.Pool.Exec(ctx, `
		UPDATE capacity_incidents
		SET status = 'resolved', resolved_at = NOW(), resolved_by = $2
		WHERE id = $1 AND status = 'open'`, id, resolvedBy)
	if err != nil {
		return fmt.Errorf("resolve capacity incident: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("incident not found or already resolved")
	}
	return nil
}
