package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// AIProvider is a row from the ai_providers table. The decrypted API key is
// loaded on-demand by the resolver via crypto.Open(secret_enc); never carry
// plaintext outside that path.
type AIProvider struct {
	ID                 uuid.UUID       `json:"id"`
	Kind               string          `json:"kind"`
	Name               string          `json:"name"`
	Config             json.RawMessage `json:"config"`
	SecretRef          string          `json:"secret_ref"`
	SecretEnc          []byte          `json:"-"` // never serialize
	HasEncryptedSecret bool            `json:"has_encrypted_secret"`
	Enabled            bool            `json:"enabled"`
	IsDefault          bool            `json:"is_default"`
	LastTestAt         *time.Time      `json:"last_test_at,omitempty"`
	LastTestOK         *bool           `json:"last_test_ok,omitempty"`
	LastTestError      string          `json:"last_test_error,omitempty"`
	LastTestLatencyMs  *int            `json:"last_test_latency_ms,omitempty"`
	LastUsedAt         *time.Time      `json:"last_used_at,omitempty"`
	UpdatedAt          time.Time       `json:"updated_at"`
	CreatedAt          time.Time       `json:"created_at"`
}

// ListAIProviders returns every configured provider, hiding ciphertext but
// reporting whether one is present.
func (p *PG) ListAIProviders(ctx context.Context) ([]AIProvider, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT id, kind, name, config, secret_ref,
		       (secret_enc IS NOT NULL),
		       enabled, is_default,
		       last_test_at, last_test_ok, COALESCE(last_test_error,''),
		       last_test_latency_ms, last_used_at, updated_at, created_at
		FROM ai_providers ORDER BY is_default DESC, name`)
	if err != nil {
		return nil, fmt.Errorf("list ai providers: %w", err)
	}
	defer rows.Close()
	out := []AIProvider{}
	for rows.Next() {
		var p AIProvider
		if err := rows.Scan(&p.ID, &p.Kind, &p.Name, &p.Config, &p.SecretRef,
			&p.HasEncryptedSecret,
			&p.Enabled, &p.IsDefault,
			&p.LastTestAt, &p.LastTestOK, &p.LastTestError,
			&p.LastTestLatencyMs, &p.LastUsedAt, &p.UpdatedAt, &p.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan ai provider: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// GetAIProviderWithSecret loads one provider including its ciphertext, so the
// resolver can decrypt and instantiate a live client.
func (p *PG) GetAIProviderWithSecret(ctx context.Context, id uuid.UUID) (*AIProvider, error) {
	row := p.Pool.QueryRow(ctx, `
		SELECT id, kind, name, config, secret_ref, secret_enc,
		       (secret_enc IS NOT NULL),
		       enabled, is_default,
		       last_test_at, last_test_ok, COALESCE(last_test_error,''),
		       last_test_latency_ms, last_used_at, updated_at, created_at
		FROM ai_providers WHERE id=$1`, id)
	var pr AIProvider
	if err := row.Scan(&pr.ID, &pr.Kind, &pr.Name, &pr.Config, &pr.SecretRef, &pr.SecretEnc,
		&pr.HasEncryptedSecret,
		&pr.Enabled, &pr.IsDefault,
		&pr.LastTestAt, &pr.LastTestOK, &pr.LastTestError,
		&pr.LastTestLatencyMs, &pr.LastUsedAt, &pr.UpdatedAt, &pr.CreatedAt); err != nil {
		return nil, fmt.Errorf("get ai provider: %w", err)
	}
	return &pr, nil
}

// GetDefaultAIProvider returns the row flagged is_default=TRUE (with secret),
// or pgx.ErrNoRows if none set.
func (p *PG) GetDefaultAIProvider(ctx context.Context) (*AIProvider, error) {
	row := p.Pool.QueryRow(ctx, `
		SELECT id, kind, name, config, secret_ref, secret_enc,
		       (secret_enc IS NOT NULL),
		       enabled, is_default,
		       last_test_at, last_test_ok, COALESCE(last_test_error,''),
		       last_test_latency_ms, last_used_at, updated_at, created_at
		FROM ai_providers WHERE is_default=TRUE AND enabled=TRUE LIMIT 1`)
	var pr AIProvider
	if err := row.Scan(&pr.ID, &pr.Kind, &pr.Name, &pr.Config, &pr.SecretRef, &pr.SecretEnc,
		&pr.HasEncryptedSecret,
		&pr.Enabled, &pr.IsDefault,
		&pr.LastTestAt, &pr.LastTestOK, &pr.LastTestError,
		&pr.LastTestLatencyMs, &pr.LastUsedAt, &pr.UpdatedAt, &pr.CreatedAt); err != nil {
		return nil, err
	}
	return &pr, nil
}

// UpsertAIProviderInput is the API surface for create/update. SecretEnc is
// optional — leave nil to keep the existing ciphertext during edit.
type UpsertAIProviderInput struct {
	ID         *uuid.UUID
	Kind       string
	Name       string
	Config     json.RawMessage
	SecretRef  string
	SecretEnc  []byte // nil ⇒ keep existing
	Enabled    bool
	IsDefault  bool
	ClearSecret bool // true ⇒ blank the ciphertext (revert to env var)
}

func (p *PG) UpsertAIProvider(ctx context.Context, in UpsertAIProviderInput) (uuid.UUID, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return uuid.Nil, fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx)

	// If marked default, clear the flag on every other row first.
	if in.IsDefault {
		if _, err := tx.Exec(ctx, `UPDATE ai_providers SET is_default=FALSE WHERE is_default=TRUE`); err != nil {
			return uuid.Nil, fmt.Errorf("clear default: %w", err)
		}
	}

	var id uuid.UUID
	if in.ID != nil && *in.ID != uuid.Nil {
		id = *in.ID
		// Preserve secret_enc unless caller is replacing or clearing it.
		setSecret := ""
		args := []any{in.Kind, in.Name, in.Config, in.SecretRef, in.Enabled, in.IsDefault, id}
		switch {
		case in.ClearSecret:
			setSecret = ", secret_enc=NULL"
		case len(in.SecretEnc) > 0:
			setSecret = ", secret_enc=$8"
			args = append(args, in.SecretEnc)
		}
		q := fmt.Sprintf(`
			UPDATE ai_providers SET kind=$1, name=$2, config=$3, secret_ref=$4,
			       enabled=$5, is_default=$6, updated_at=now()%s
			WHERE id=$7`, setSecret)
		if _, err := tx.Exec(ctx, q, args...); err != nil {
			return uuid.Nil, fmt.Errorf("update ai provider: %w", err)
		}
	} else {
		row := tx.QueryRow(ctx, `
			INSERT INTO ai_providers (kind, name, config, secret_ref, secret_enc, enabled, is_default)
			VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
			in.Kind, in.Name, in.Config, in.SecretRef, nilIfEmpty(in.SecretEnc), in.Enabled, in.IsDefault)
		if err := row.Scan(&id); err != nil {
			return uuid.Nil, fmt.Errorf("insert ai provider: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, err
	}
	return id, nil
}

func (p *PG) DeleteAIProvider(ctx context.Context, id uuid.UUID) error {
	_, err := p.Pool.Exec(ctx, `DELETE FROM ai_providers WHERE id=$1`, id)
	if err != nil {
		return fmt.Errorf("delete ai provider: %w", err)
	}
	return nil
}

// RecordAITestResult persists the connection test outcome. Best-effort: errors
// here are logged but do not abort the test return path.
func (p *PG) RecordAITestResult(ctx context.Context, id uuid.UUID, ok bool, errMsg string, latencyMs int) error {
	_, err := p.Pool.Exec(ctx, `
		UPDATE ai_providers
		SET last_test_at=now(), last_test_ok=$1, last_test_error=NULLIF($2,''), last_test_latency_ms=$3
		WHERE id=$4`, ok, errMsg, latencyMs, id)
	if err != nil {
		return fmt.Errorf("record ai test: %w", err)
	}
	return nil
}

// MarkAIUsed bumps last_used_at; called from the instrumentation wrapper.
func (p *PG) MarkAIUsed(ctx context.Context, id uuid.UUID) error {
	_, err := p.Pool.Exec(ctx, `UPDATE ai_providers SET last_used_at=now() WHERE id=$1`, id)
	return err
}

func nilIfEmpty(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return b
}
