package store

// Backend pricing + cost snapshots — SQL boundary for the Costs
// dashboard. Pricing rows are operator-curated; snapshots are written
// by the cost calculator (api/costs.go) so the 12-month chart has a
// stable timeline that doesn't depend on whether features were
// computed historically.

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

type BackendPricing struct {
	ID                       uuid.UUID `json:"id"`
	Name                     string    `json:"name"`
	DisplayName              string    `json:"display_name"`
	Kind                     string    `json:"kind"` // hot|warm|cold|archive
	Currency                 string    `json:"currency"`
	StoragePricePerTBMonth   float64   `json:"storage_price_per_tb_month"`
	EgressPricePerTB         float64   `json:"egress_price_per_tb"`
	RequestPricePerMillion   float64   `json:"request_price_per_million"`
	MinBillableBytes         int64     `json:"min_billable_bytes"`
	ReplicationFactor        float64   `json:"replication_factor"`
	IsHotReference           bool      `json:"is_hot_reference"`
	Notes                    string    `json:"notes"`
	CreatedAt                time.Time `json:"created_at"`
	UpdatedAt                time.Time `json:"updated_at"`
}

func (p *PG) ListBackendPricing(ctx context.Context) ([]BackendPricing, error) {
	rows, err := p.Pool.Query(ctx, `
        SELECT id, name, display_name, kind, currency,
               storage_price_per_tb_month, egress_price_per_tb, request_price_per_million,
               min_billable_bytes, replication_factor, is_hot_reference,
               notes, created_at, updated_at
          FROM backend_pricing
         ORDER BY is_hot_reference DESC, kind, name`)
	if err != nil {
		return nil, fmt.Errorf("list pricing: %w", err)
	}
	defer rows.Close()
	out := []BackendPricing{}
	for rows.Next() {
		var b BackendPricing
		if err := rows.Scan(&b.ID, &b.Name, &b.DisplayName, &b.Kind, &b.Currency,
			&b.StoragePricePerTBMonth, &b.EgressPricePerTB, &b.RequestPricePerMillion,
			&b.MinBillableBytes, &b.ReplicationFactor, &b.IsHotReference,
			&b.Notes, &b.CreatedAt, &b.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan pricing: %w", err)
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// UpsertBackendPricing creates or replaces a pricing row keyed by
// name. If is_hot_reference is true on the incoming row, we clear it
// from any other row in the same transaction so the partial unique
// index doesn't fire (and so the dashboard always has exactly one
// reference).
func (p *PG) UpsertBackendPricing(ctx context.Context, b *BackendPricing) error {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin pricing tx: %w", err)
	}
	defer tx.Rollback(ctx)
	if b.IsHotReference {
		if _, err := tx.Exec(ctx,
			`UPDATE backend_pricing SET is_hot_reference = false WHERE is_hot_reference AND name <> $1`,
			b.Name); err != nil {
			return fmt.Errorf("clear other hot ref: %w", err)
		}
	}
	row := tx.QueryRow(ctx, `
        INSERT INTO backend_pricing
            (id, name, display_name, kind, currency,
             storage_price_per_tb_month, egress_price_per_tb, request_price_per_million,
             min_billable_bytes, replication_factor, is_hot_reference, notes,
             updated_at)
        VALUES (COALESCE(NULLIF($1::text,'')::uuid, gen_random_uuid()),
                $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
        ON CONFLICT (name) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            kind = EXCLUDED.kind,
            currency = EXCLUDED.currency,
            storage_price_per_tb_month = EXCLUDED.storage_price_per_tb_month,
            egress_price_per_tb = EXCLUDED.egress_price_per_tb,
            request_price_per_million = EXCLUDED.request_price_per_million,
            min_billable_bytes = EXCLUDED.min_billable_bytes,
            replication_factor = EXCLUDED.replication_factor,
            is_hot_reference = EXCLUDED.is_hot_reference,
            notes = EXCLUDED.notes,
            updated_at = now()
        RETURNING id, created_at, updated_at`,
		b.ID.String(), b.Name, b.DisplayName, b.Kind, b.Currency,
		b.StoragePricePerTBMonth, b.EgressPricePerTB, b.RequestPricePerMillion,
		b.MinBillableBytes, b.ReplicationFactor, b.IsHotReference, b.Notes)
	if err := row.Scan(&b.ID, &b.CreatedAt, &b.UpdatedAt); err != nil {
		return fmt.Errorf("upsert pricing: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit pricing: %w", err)
	}
	return nil
}

func (p *PG) DeleteBackendPricing(ctx context.Context, id uuid.UUID) error {
	_, err := p.Pool.Exec(ctx, `DELETE FROM backend_pricing WHERE id=$1`, id)
	if err != nil {
		return fmt.Errorf("delete pricing: %w", err)
	}
	return nil
}

// HotReference returns the row flagged as the counterfactual basis,
// or nil if none is configured (the dashboard then can't compute
// savings until the operator picks one).
func (p *PG) HotReferencePricing(ctx context.Context) (*BackendPricing, error) {
	row := p.Pool.QueryRow(ctx, `
        SELECT id, name, display_name, kind, currency,
               storage_price_per_tb_month, egress_price_per_tb, request_price_per_million,
               min_billable_bytes, replication_factor, is_hot_reference,
               notes, created_at, updated_at
          FROM backend_pricing WHERE is_hot_reference LIMIT 1`)
	var b BackendPricing
	if err := row.Scan(&b.ID, &b.Name, &b.DisplayName, &b.Kind, &b.Currency,
		&b.StoragePricePerTBMonth, &b.EgressPricePerTB, &b.RequestPricePerMillion,
		&b.MinBillableBytes, &b.ReplicationFactor, &b.IsHotReference,
		&b.Notes, &b.CreatedAt, &b.UpdatedAt); err != nil {
		return nil, err
	}
	return &b, nil
}

// ---- cost snapshots ----

type CostSnapshot struct {
	ClusterID          uuid.UUID `json:"cluster_id"`
	BackendName        string    `json:"backend_name"`
	YearMonth          time.Time `json:"year_month"`
	PhysicalBytes      int64     `json:"physical_bytes"`
	LogicalBytes       int64     `json:"logical_bytes"`
	CostEstimate       float64   `json:"cost_estimate"`
	CounterfactualCost float64   `json:"counterfactual_cost"`
	Currency           string    `json:"currency"`
	CapturedAt         time.Time `json:"captured_at"`
}

// UpsertCostSnapshots writes one snapshot per (cluster, backend) for
// the current year-month, replacing any prior row in the same bucket.
// Idempotent for the same calendar month, so a manual "snapshot now"
// click safely overwrites the dashboard timeline's tail.
func (p *PG) UpsertCostSnapshots(ctx context.Context, snaps []CostSnapshot) error {
	if len(snaps) == 0 {
		return nil
	}
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin snapshot tx: %w", err)
	}
	defer tx.Rollback(ctx)
	for _, s := range snaps {
		_, err := tx.Exec(ctx, `
            INSERT INTO cost_snapshots
                (cluster_id, backend_name, year_month,
                 physical_bytes, logical_bytes, cost_estimate, counterfactual_cost, currency)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT (cluster_id, backend_name, year_month) DO UPDATE SET
                physical_bytes = EXCLUDED.physical_bytes,
                logical_bytes = EXCLUDED.logical_bytes,
                cost_estimate = EXCLUDED.cost_estimate,
                counterfactual_cost = EXCLUDED.counterfactual_cost,
                currency = EXCLUDED.currency,
                captured_at = now()`,
			s.ClusterID, s.BackendName, s.YearMonth,
			s.PhysicalBytes, s.LogicalBytes, s.CostEstimate, s.CounterfactualCost, s.Currency)
		if err != nil {
			return fmt.Errorf("upsert snapshot: %w", err)
		}
	}
	return tx.Commit(ctx)
}

// ListCostSnapshots returns rows for the last `months` calendar months
// for a cluster, ordered oldest→newest so the chart can scan left to
// right without resorting client-side.
func (p *PG) ListCostSnapshots(ctx context.Context, clusterID uuid.UUID, months int) ([]CostSnapshot, error) {
	if months <= 0 || months > 36 {
		months = 12
	}
	rows, err := p.Pool.Query(ctx, `
        SELECT cluster_id, backend_name, year_month,
               physical_bytes, logical_bytes, cost_estimate, counterfactual_cost, currency, captured_at
          FROM cost_snapshots
         WHERE cluster_id = $1
           AND year_month >= date_trunc('month', now()) - ($2::int || ' months')::interval
         ORDER BY year_month ASC, backend_name`,
		clusterID, months)
	if err != nil {
		return nil, fmt.Errorf("list snapshots: %w", err)
	}
	defer rows.Close()
	out := []CostSnapshot{}
	for rows.Next() {
		var s CostSnapshot
		if err := rows.Scan(&s.ClusterID, &s.BackendName, &s.YearMonth,
			&s.PhysicalBytes, &s.LogicalBytes, &s.CostEstimate, &s.CounterfactualCost, &s.Currency, &s.CapturedAt); err != nil {
			return nil, fmt.Errorf("scan snapshot: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}
