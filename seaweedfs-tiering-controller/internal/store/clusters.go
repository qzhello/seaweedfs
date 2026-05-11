package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// ----------------------------- Clusters -----------------------------

type Cluster struct {
	ID             uuid.UUID       `json:"id"`
	Name           string          `json:"name"`
	MasterAddr     string          `json:"master_addr"`
	FilerAddr      string          `json:"filer_addr"`
	GrpcTLS        bool            `json:"grpc_tls"`
	Description    string          `json:"description"`
	BusinessDomain string          `json:"business_domain"`
	Guard          json.RawMessage `json:"guard"`
	Enabled        bool            `json:"enabled"`
	// WeedBinPath is an optional absolute path to the `weed` binary the
	// controller should invoke for `weed shell` calls against this cluster.
	// Empty string → fall back to the global resolution chain (env / PATH).
	WeedBinPath string    `json:"weed_bin_path"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (p *PG) ListClusters(ctx context.Context) ([]Cluster, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT id,name,master_addr,filer_addr,grpc_tls,description,business_domain,guard,enabled,weed_bin_path,created_at,updated_at
		FROM clusters ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("list clusters: %w", err)
	}
	defer rows.Close()
	out := []Cluster{}
	for rows.Next() {
		var c Cluster
		if err := rows.Scan(&c.ID, &c.Name, &c.MasterAddr, &c.FilerAddr, &c.GrpcTLS,
			&c.Description, &c.BusinessDomain, &c.Guard, &c.Enabled, &c.WeedBinPath,
			&c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan cluster: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (p *PG) GetCluster(ctx context.Context, id uuid.UUID) (*Cluster, error) {
	row := p.Pool.QueryRow(ctx, `
		SELECT id,name,master_addr,filer_addr,grpc_tls,description,business_domain,guard,enabled,weed_bin_path,created_at,updated_at
		FROM clusters WHERE id=$1`, id)
	var c Cluster
	if err := row.Scan(&c.ID, &c.Name, &c.MasterAddr, &c.FilerAddr, &c.GrpcTLS,
		&c.Description, &c.BusinessDomain, &c.Guard, &c.Enabled, &c.WeedBinPath,
		&c.CreatedAt, &c.UpdatedAt); err != nil {
		return nil, fmt.Errorf("get cluster: %w", err)
	}
	return &c, nil
}

func (p *PG) UpsertCluster(ctx context.Context, c Cluster) (uuid.UUID, error) {
	if c.ID == uuid.Nil {
		c.ID = uuid.New()
	}
	if len(c.Guard) == 0 {
		c.Guard = json.RawMessage(`{}`)
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO clusters (id,name,master_addr,filer_addr,grpc_tls,description,business_domain,guard,enabled,weed_bin_path)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		ON CONFLICT (name) DO UPDATE SET
		  master_addr=EXCLUDED.master_addr, filer_addr=EXCLUDED.filer_addr,
		  grpc_tls=EXCLUDED.grpc_tls, description=EXCLUDED.description,
		  business_domain=EXCLUDED.business_domain, guard=EXCLUDED.guard,
		  enabled=EXCLUDED.enabled, weed_bin_path=EXCLUDED.weed_bin_path,
		  updated_at=NOW()`,
		c.ID, c.Name, c.MasterAddr, c.FilerAddr, c.GrpcTLS, c.Description,
		c.BusinessDomain, c.Guard, c.Enabled, c.WeedBinPath)
	if err != nil {
		return uuid.Nil, fmt.Errorf("upsert cluster: %w", err)
	}
	return c.ID, nil
}

func (p *PG) DeleteCluster(ctx context.Context, id uuid.UUID) error {
	_, err := p.Pool.Exec(ctx, `DELETE FROM clusters WHERE id=$1`, id)
	if err != nil {
		return fmt.Errorf("delete cluster: %w", err)
	}
	return nil
}

// ------------------------------ Tags --------------------------------

type ResourceTag struct {
	ID               uuid.UUID `json:"id"`
	ClusterID        uuid.UUID `json:"cluster_id"`
	ScopeKind        string    `json:"scope_kind"`
	ScopeValue       string    `json:"scope_value"`
	BusinessDomain   string    `json:"business_domain"`
	DataType         *string   `json:"data_type,omitempty"`
	HolidaySensitive bool      `json:"holiday_sensitive"`
	Notes            string    `json:"notes"`
	CreatedAt        time.Time `json:"created_at"`
}

func (p *PG) ListTags(ctx context.Context, clusterID uuid.UUID) ([]ResourceTag, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT id,cluster_id,scope_kind,scope_value,business_domain,data_type,holiday_sensitive,notes,created_at
		FROM resource_tags WHERE cluster_id=$1 ORDER BY scope_kind, scope_value`, clusterID)
	if err != nil {
		return nil, fmt.Errorf("list tags: %w", err)
	}
	defer rows.Close()
	out := []ResourceTag{}
	for rows.Next() {
		var t ResourceTag
		if err := rows.Scan(&t.ID, &t.ClusterID, &t.ScopeKind, &t.ScopeValue,
			&t.BusinessDomain, &t.DataType, &t.HolidaySensitive, &t.Notes, &t.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan tag: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (p *PG) UpsertTag(ctx context.Context, t ResourceTag) (uuid.UUID, error) {
	if t.ID == uuid.Nil {
		t.ID = uuid.New()
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO resource_tags (id,cluster_id,scope_kind,scope_value,business_domain,data_type,holiday_sensitive,notes)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (cluster_id,scope_kind,scope_value,business_domain) DO UPDATE SET
		  data_type=EXCLUDED.data_type, holiday_sensitive=EXCLUDED.holiday_sensitive, notes=EXCLUDED.notes`,
		t.ID, t.ClusterID, t.ScopeKind, t.ScopeValue, t.BusinessDomain,
		t.DataType, t.HolidaySensitive, t.Notes)
	if err != nil {
		return uuid.Nil, fmt.Errorf("upsert tag: %w", err)
	}
	return t.ID, nil
}

func (p *PG) DeleteTag(ctx context.Context, id uuid.UUID) error {
	_, err := p.Pool.Exec(ctx, `DELETE FROM resource_tags WHERE id=$1`, id)
	if err != nil {
		return fmt.Errorf("delete tag: %w", err)
	}
	return nil
}

// --------------------------- Node usage snapshot ---------------------------

type NodeUsage struct {
	SnapshotAt  time.Time `json:"snapshot_at"`
	ClusterID   uuid.UUID `json:"cluster_id"`
	DataCenter  string    `json:"data_center"`
	Rack        string    `json:"rack"`
	Node        string    `json:"node"`
	DiskType    string    `json:"disk_type"`
	Capacity    int64     `json:"capacity"`
	Used        int64     `json:"used"`
	VolumeCount int32     `json:"volume_count"`
}

func (p *PG) PutNodeUsage(ctx context.Context, rows []NodeUsage) error {
	if len(rows) == 0 {
		return nil
	}
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx)
	for _, r := range rows {
		if _, err := tx.Exec(ctx, `
			INSERT INTO node_usage_snapshot (snapshot_at,cluster_id,data_center,rack,node,disk_type,capacity,used,volume_count)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
			ON CONFLICT (snapshot_at,cluster_id,node,disk_type) DO UPDATE SET
			  capacity=EXCLUDED.capacity, used=EXCLUDED.used, volume_count=EXCLUDED.volume_count`,
			r.SnapshotAt, r.ClusterID, r.DataCenter, r.Rack, r.Node, r.DiskType,
			r.Capacity, r.Used, r.VolumeCount); err != nil {
			return fmt.Errorf("insert node usage: %w", err)
		}
	}
	return tx.Commit(ctx)
}

func (p *PG) LatestNodeUsage(ctx context.Context, clusterID uuid.UUID) ([]NodeUsage, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT DISTINCT ON (cluster_id,node,disk_type)
		  snapshot_at,cluster_id,data_center,rack,node,disk_type,capacity,used,volume_count
		FROM node_usage_snapshot
		WHERE cluster_id=$1
		ORDER BY cluster_id,node,disk_type, snapshot_at DESC`, clusterID)
	if err != nil {
		return nil, fmt.Errorf("latest node usage: %w", err)
	}
	defer rows.Close()
	out := []NodeUsage{}
	for rows.Next() {
		var u NodeUsage
		if err := rows.Scan(&u.SnapshotAt, &u.ClusterID, &u.DataCenter, &u.Rack,
			&u.Node, &u.DiskType, &u.Capacity, &u.Used, &u.VolumeCount); err != nil {
			return nil, fmt.Errorf("scan usage: %w", err)
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// ----------------------------- Holidays -----------------------------

type Holiday struct {
	Date           time.Time `json:"date"`
	Name           string    `json:"name"`
	Kind           string    `json:"kind"`
	PreWindowDays  int       `json:"pre_window_days"`
	PostWindowDays int       `json:"post_window_days"`
	Notes          string    `json:"notes"`
}

func (p *PG) ListHolidays(ctx context.Context, from, to time.Time) ([]Holiday, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT date,name,kind,pre_window_days,post_window_days,notes
		FROM holiday_calendar WHERE date BETWEEN $1 AND $2 ORDER BY date`, from, to)
	if err != nil {
		return nil, fmt.Errorf("list holidays: %w", err)
	}
	defer rows.Close()
	out := []Holiday{}
	for rows.Next() {
		var h Holiday
		if err := rows.Scan(&h.Date, &h.Name, &h.Kind, &h.PreWindowDays, &h.PostWindowDays, &h.Notes); err != nil {
			return nil, fmt.Errorf("scan holiday: %w", err)
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// InHolidayFreeze returns true if `now` falls inside any holiday's [pre, post] window.
// Returns the matched holiday name for logging.
func (p *PG) InHolidayFreeze(ctx context.Context, now time.Time) (bool, string, error) {
	row := p.Pool.QueryRow(ctx, `
		SELECT name FROM holiday_calendar
		WHERE kind='holiday'
		  AND $1::date BETWEEN (date - pre_window_days * INTERVAL '1 day')::date
		                   AND (date + post_window_days * INTERVAL '1 day')::date
		LIMIT 1`, now)
	var name string
	switch err := row.Scan(&name); err {
	case nil:
		return true, name, nil
	default:
		if err.Error() == "no rows in result set" {
			return false, "", nil
		}
		return false, "", fmt.Errorf("check holiday freeze: %w", err)
	}
}
