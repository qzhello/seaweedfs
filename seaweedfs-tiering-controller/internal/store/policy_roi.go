package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"
)

// PolicyTaskStat is the per-policy task rollup powering the policy ROI
// view — how many tasks each policy's scope has produced, by status.
type PolicyTaskStat struct {
	PolicyID  uuid.UUID `json:"policy_id"`
	Total     int       `json:"total"`
	Pending   int       `json:"pending"`
	Approved  int       `json:"approved"`
	Running   int       `json:"running"`
	Succeeded int       `json:"succeeded"`
	Failed    int       `json:"failed"`
	Other     int       `json:"other"`
}

// PolicyTaskStats aggregates tasks by policy_id and status, keyed by
// policy id. Tasks with a NULL policy_id (no policy scope claimed the
// volume's collection) are excluded — they have no policy to credit.
func (p *PG) PolicyTaskStats(ctx context.Context) (map[uuid.UUID]PolicyTaskStat, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT policy_id, status, count(*)
		FROM tasks
		WHERE policy_id IS NOT NULL
		GROUP BY policy_id, status`)
	if err != nil {
		return nil, fmt.Errorf("policy task stats: %w", err)
	}
	defer rows.Close()
	out := map[uuid.UUID]PolicyTaskStat{}
	for rows.Next() {
		var pid uuid.UUID
		var status string
		var n int
		if err := rows.Scan(&pid, &status, &n); err != nil {
			return nil, fmt.Errorf("scan policy stat: %w", err)
		}
		st := out[pid]
		st.PolicyID = pid
		st.Total += n
		switch status {
		case "pending":
			st.Pending += n
		case "approved":
			st.Approved += n
		case "running":
			st.Running += n
		case "succeeded":
			st.Succeeded += n
		case "failed":
			st.Failed += n
		default:
			st.Other += n
		}
		out[pid] = st
	}
	return out, rows.Err()
}
