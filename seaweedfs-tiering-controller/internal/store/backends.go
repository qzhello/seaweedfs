package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Backend mirrors storage_backends. SecretEnc is the AES-GCM ciphertext of
// the secret access key; the API layer is responsible for encrypting on
// write and never returning it on read.
type Backend struct {
	ID              uuid.UUID  `json:"id"`
	Name            string     `json:"name"`
	Kind            string     `json:"kind"`
	Endpoint        string     `json:"endpoint"`
	Region          string     `json:"region"`
	Bucket          string     `json:"bucket"`
	PathPrefix      string     `json:"path_prefix"`
	AccessKeyID     string     `json:"access_key_id"`
	SecretEnc       []byte     `json:"-"` // never serialized
	HasSecret       bool       `json:"has_secret"`
	Encryption      string     `json:"encryption"`
	ForcePathStyle  bool       `json:"force_path_style"`
	Notes           string     `json:"notes"`
	Enabled         bool       `json:"enabled"`
	LastTestAt      *time.Time `json:"last_test_at,omitempty"`
	LastTestOK      *bool      `json:"last_test_ok,omitempty"`
	LastTestError   string     `json:"last_test_error"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

func (p *PG) ListBackends(ctx context.Context) ([]Backend, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT id,name,kind,endpoint,region,bucket,path_prefix,access_key_id,
		       (secret_enc IS NOT NULL) AS has_secret,
		       encryption,force_path_style,notes,enabled,
		       last_test_at,last_test_ok,last_test_error,created_at,updated_at
		FROM storage_backends ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("list backends: %w", err)
	}
	defer rows.Close()
	out := []Backend{}
	for rows.Next() {
		var b Backend
		if err := rows.Scan(&b.ID, &b.Name, &b.Kind, &b.Endpoint, &b.Region, &b.Bucket,
			&b.PathPrefix, &b.AccessKeyID, &b.HasSecret, &b.Encryption, &b.ForcePathStyle,
			&b.Notes, &b.Enabled, &b.LastTestAt, &b.LastTestOK, &b.LastTestError,
			&b.CreatedAt, &b.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan backend: %w", err)
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (p *PG) GetBackendWithSecret(ctx context.Context, id uuid.UUID) (*Backend, error) {
	row := p.Pool.QueryRow(ctx, `
		SELECT id,name,kind,endpoint,region,bucket,path_prefix,access_key_id,
		       secret_enc,(secret_enc IS NOT NULL),
		       encryption,force_path_style,notes,enabled,
		       last_test_at,last_test_ok,last_test_error,created_at,updated_at
		FROM storage_backends WHERE id=$1`, id)
	var b Backend
	if err := row.Scan(&b.ID, &b.Name, &b.Kind, &b.Endpoint, &b.Region, &b.Bucket,
		&b.PathPrefix, &b.AccessKeyID, &b.SecretEnc, &b.HasSecret, &b.Encryption,
		&b.ForcePathStyle, &b.Notes, &b.Enabled,
		&b.LastTestAt, &b.LastTestOK, &b.LastTestError,
		&b.CreatedAt, &b.UpdatedAt); err != nil {
		return nil, fmt.Errorf("get backend: %w", err)
	}
	return &b, nil
}

// UpsertBackend writes a backend row. If secretEnc is nil, the existing
// ciphertext (if any) is preserved (so admins can edit notes without
// re-entering the secret).
func (p *PG) UpsertBackend(ctx context.Context, b Backend, secretEnc []byte) (uuid.UUID, error) {
	if b.ID == uuid.Nil {
		b.ID = uuid.New()
	}
	if secretEnc == nil {
		_, err := p.Pool.Exec(ctx, `
			INSERT INTO storage_backends
			  (id,name,kind,endpoint,region,bucket,path_prefix,access_key_id,
			   encryption,force_path_style,notes,enabled)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
			ON CONFLICT (name) DO UPDATE SET
			  kind=EXCLUDED.kind, endpoint=EXCLUDED.endpoint, region=EXCLUDED.region,
			  bucket=EXCLUDED.bucket, path_prefix=EXCLUDED.path_prefix,
			  access_key_id=EXCLUDED.access_key_id, encryption=EXCLUDED.encryption,
			  force_path_style=EXCLUDED.force_path_style, notes=EXCLUDED.notes,
			  enabled=EXCLUDED.enabled, updated_at=NOW()`,
			b.ID, b.Name, b.Kind, b.Endpoint, b.Region, b.Bucket, b.PathPrefix,
			b.AccessKeyID, b.Encryption, b.ForcePathStyle, b.Notes, b.Enabled)
		if err != nil {
			return uuid.Nil, fmt.Errorf("upsert backend: %w", err)
		}
		return b.ID, nil
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO storage_backends
		  (id,name,kind,endpoint,region,bucket,path_prefix,access_key_id,secret_enc,
		   encryption,force_path_style,notes,enabled)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		ON CONFLICT (name) DO UPDATE SET
		  kind=EXCLUDED.kind, endpoint=EXCLUDED.endpoint, region=EXCLUDED.region,
		  bucket=EXCLUDED.bucket, path_prefix=EXCLUDED.path_prefix,
		  access_key_id=EXCLUDED.access_key_id, secret_enc=EXCLUDED.secret_enc,
		  encryption=EXCLUDED.encryption, force_path_style=EXCLUDED.force_path_style,
		  notes=EXCLUDED.notes, enabled=EXCLUDED.enabled, updated_at=NOW()`,
		b.ID, b.Name, b.Kind, b.Endpoint, b.Region, b.Bucket, b.PathPrefix,
		b.AccessKeyID, secretEnc, b.Encryption, b.ForcePathStyle, b.Notes, b.Enabled)
	if err != nil {
		return uuid.Nil, fmt.Errorf("upsert backend: %w", err)
	}
	return b.ID, nil
}

func (p *PG) DeleteBackend(ctx context.Context, id uuid.UUID) error {
	_, err := p.Pool.Exec(ctx, `DELETE FROM storage_backends WHERE id=$1`, id)
	if err != nil {
		return fmt.Errorf("delete backend: %w", err)
	}
	return nil
}

func (p *PG) RecordBackendTest(ctx context.Context, id uuid.UUID, ok bool, errMsg string) error {
	_, err := p.Pool.Exec(ctx,
		`UPDATE storage_backends SET last_test_at=NOW(), last_test_ok=$1, last_test_error=$2 WHERE id=$3`,
		ok, errMsg, id)
	if err != nil {
		return fmt.Errorf("record backend test: %w", err)
	}
	return nil
}
