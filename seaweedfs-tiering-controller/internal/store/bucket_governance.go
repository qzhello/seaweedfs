package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// BucketGovernance is the controller-side metadata for one bucket:
// ownership plus a data-lifecycle retention rule and its last scan
// result. See migration 039.
type BucketGovernance struct {
	ID             uuid.UUID       `json:"id"`
	ClusterID      uuid.UUID       `json:"cluster_id"`
	BucketName     string          `json:"bucket_name"`
	OwnerName      string          `json:"owner_name"`
	OwnerUserKey   string          `json:"owner_user_key"`
	RetentionDays  *int            `json:"retention_days,omitempty"` // nil = no retention rule
	Notes          string          `json:"notes"`
	LastScanAt     *time.Time      `json:"last_scan_at,omitempty"`
	ExpiredObjects int64           `json:"expired_objects"`
	ExpiredBytes   int64           `json:"expired_bytes"`
	ScanTruncated  bool            `json:"scan_truncated"`
	ExpiredSample  json.RawMessage `json:"expired_sample,omitempty"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
	ClusterName    string          `json:"cluster_name"` // joined, not a column
}

const bucketGovernanceCols = `id, cluster_id, bucket_name, owner_name, owner_user_key,
	retention_days, notes, last_scan_at, expired_objects, expired_bytes,
	scan_truncated, expired_sample, created_at, updated_at`

func scanBucketGovernance(s interface{ Scan(dest ...any) error }) (BucketGovernance, error) {
	var g BucketGovernance
	err := s.Scan(&g.ID, &g.ClusterID, &g.BucketName, &g.OwnerName, &g.OwnerUserKey,
		&g.RetentionDays, &g.Notes, &g.LastScanAt, &g.ExpiredObjects, &g.ExpiredBytes,
		&g.ScanTruncated, &g.ExpiredSample, &g.CreatedAt, &g.UpdatedAt)
	return g, err
}

// ListBucketGovernance returns every governance row for a cluster, keyed
// by bucket name — so the buckets handler enriches its list in one query.
func (p *PG) ListBucketGovernance(ctx context.Context, clusterID uuid.UUID) (map[string]BucketGovernance, error) {
	rows, err := p.Pool.Query(ctx,
		`SELECT `+bucketGovernanceCols+` FROM bucket_governance WHERE cluster_id = $1`, clusterID)
	if err != nil {
		return nil, fmt.Errorf("list bucket governance: %w", err)
	}
	defer rows.Close()
	out := map[string]BucketGovernance{}
	for rows.Next() {
		g, err := scanBucketGovernance(rows)
		if err != nil {
			return nil, fmt.Errorf("scan bucket governance: %w", err)
		}
		out[g.BucketName] = g
	}
	return out, rows.Err()
}

// GetBucketGovernance returns one bucket's governance row, or (nil, nil)
// when the bucket has no governance record yet.
func (p *PG) GetBucketGovernance(ctx context.Context, clusterID uuid.UUID, bucket string) (*BucketGovernance, error) {
	rows, err := p.Pool.Query(ctx,
		`SELECT `+bucketGovernanceCols+`
		 FROM bucket_governance WHERE cluster_id = $1 AND bucket_name = $2`, clusterID, bucket)
	if err != nil {
		return nil, fmt.Errorf("get bucket governance: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	g, err := scanBucketGovernance(rows)
	if err != nil {
		return nil, fmt.Errorf("scan bucket governance: %w", err)
	}
	return &g, nil
}

// UpsertBucketGovernance sets the owner / retention / notes for a bucket.
// Scan-result columns are deliberately left untouched.
func (p *PG) UpsertBucketGovernance(ctx context.Context, clusterID uuid.UUID, bucket,
	ownerName, ownerUserKey string, retentionDays *int, notes string) error {
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO bucket_governance
		    (cluster_id, bucket_name, owner_name, owner_user_key, retention_days, notes)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (cluster_id, bucket_name) DO UPDATE SET
		    owner_name     = EXCLUDED.owner_name,
		    owner_user_key = EXCLUDED.owner_user_key,
		    retention_days = EXCLUDED.retention_days,
		    notes          = EXCLUDED.notes,
		    updated_at     = NOW()`,
		clusterID, bucket, ownerName, ownerUserKey, retentionDays, notes)
	if err != nil {
		return fmt.Errorf("upsert bucket governance: %w", err)
	}
	return nil
}

// ListGovernedBuckets returns every bucket with a retention rule across
// all clusters, joined with the cluster name and ordered expired-first —
// the cross-cluster data-lifecycle monitoring view.
func (p *PG) ListGovernedBuckets(ctx context.Context) ([]BucketGovernance, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT g.id, g.cluster_id, g.bucket_name, g.owner_name, g.owner_user_key,
		       g.retention_days, g.notes, g.last_scan_at, g.expired_objects, g.expired_bytes,
		       g.scan_truncated, g.expired_sample, g.created_at, g.updated_at,
		       COALESCE(cl.name, '')
		FROM bucket_governance g
		LEFT JOIN clusters cl ON cl.id = g.cluster_id
		WHERE g.retention_days IS NOT NULL
		ORDER BY g.expired_objects DESC, g.expired_bytes DESC, g.bucket_name`)
	if err != nil {
		return nil, fmt.Errorf("list governed buckets: %w", err)
	}
	defer rows.Close()
	out := []BucketGovernance{}
	for rows.Next() {
		var g BucketGovernance
		if err := rows.Scan(&g.ID, &g.ClusterID, &g.BucketName, &g.OwnerName, &g.OwnerUserKey,
			&g.RetentionDays, &g.Notes, &g.LastScanAt, &g.ExpiredObjects, &g.ExpiredBytes,
			&g.ScanTruncated, &g.ExpiredSample, &g.CreatedAt, &g.UpdatedAt, &g.ClusterName); err != nil {
			return nil, fmt.Errorf("scan governed bucket: %w", err)
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// RecordBucketScan stores the result of a lifecycle scan. The governance
// row must already exist (a scan only runs once retention is set).
func (p *PG) RecordBucketScan(ctx context.Context, clusterID uuid.UUID, bucket string,
	expiredObjects, expiredBytes int64, truncated bool, sample any) error {
	b, err := json.Marshal(sample)
	if err != nil {
		return fmt.Errorf("marshal scan sample: %w", err)
	}
	tag, err := p.Pool.Exec(ctx, `
		UPDATE bucket_governance SET
		    last_scan_at    = NOW(),
		    expired_objects = $3,
		    expired_bytes   = $4,
		    scan_truncated  = $5,
		    expired_sample  = $6,
		    updated_at      = NOW()
		WHERE cluster_id = $1 AND bucket_name = $2`,
		clusterID, bucket, expiredObjects, expiredBytes, truncated, b)
	if err != nil {
		return fmt.Errorf("record bucket scan: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("bucket governance row not found")
	}
	return nil
}
