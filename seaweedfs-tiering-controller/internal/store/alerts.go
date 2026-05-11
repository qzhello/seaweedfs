package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

type AlertChannel struct {
	ID          uuid.UUID       `json:"id"`
	Name        string          `json:"name"`
	Kind        string          `json:"kind"`
	Config      json.RawMessage `json:"config"`
	Severities  []string        `json:"severities"`
	RatePerHour int             `json:"rate_per_hour"`
	Enabled     bool            `json:"enabled"`
	Notes       string          `json:"notes"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
}

type AlertRule struct {
	ID          uuid.UUID   `json:"id"`
	Name        string      `json:"name"`
	EventKind   string      `json:"event_kind"`
	SourceMatch string      `json:"source_match"`
	SeverityMin string      `json:"severity_min"`
	ChannelIDs  []uuid.UUID `json:"channel_ids"`
	SilenceSec  int         `json:"silence_sec"`
	Enabled     bool        `json:"enabled"`
	CreatedAt   time.Time   `json:"created_at"`
}

type AlertEvent struct {
	ID               int64           `json:"id"`
	FiredAt          time.Time       `json:"fired_at"`
	EventKind        string          `json:"event_kind"`
	Source           string          `json:"source"`
	Severity         string          `json:"severity"`
	Title            string          `json:"title"`
	Body             string          `json:"body"`
	Payload          json.RawMessage `json:"payload"`
	Deliveries       json.RawMessage `json:"deliveries"`
	Suppressed       bool            `json:"suppressed"`
	SuppressedReason string          `json:"suppressed_reason"`
}

func (p *PG) ListAlertChannels(ctx context.Context) ([]AlertChannel, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT id,name,kind,config,severities,rate_per_hour,enabled,notes,created_at,updated_at
		FROM alert_channels ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("list alert channels: %w", err)
	}
	defer rows.Close()
	out := []AlertChannel{}
	for rows.Next() {
		var c AlertChannel
		if err := rows.Scan(&c.ID, &c.Name, &c.Kind, &c.Config, &c.Severities,
			&c.RatePerHour, &c.Enabled, &c.Notes, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan channel: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (p *PG) UpsertAlertChannel(ctx context.Context, c AlertChannel) (uuid.UUID, error) {
	if c.ID == uuid.Nil {
		c.ID = uuid.New()
	}
	if c.RatePerHour < 0 {
		c.RatePerHour = 0
	}
	if len(c.Severities) == 0 {
		c.Severities = []string{"warning", "critical"}
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO alert_channels (id,name,kind,config,severities,rate_per_hour,enabled,notes)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (name) DO UPDATE SET
		  kind=EXCLUDED.kind, config=EXCLUDED.config, severities=EXCLUDED.severities,
		  rate_per_hour=EXCLUDED.rate_per_hour, enabled=EXCLUDED.enabled,
		  notes=EXCLUDED.notes, updated_at=NOW()`,
		c.ID, c.Name, c.Kind, c.Config, c.Severities, c.RatePerHour, c.Enabled, c.Notes)
	if err != nil {
		return uuid.Nil, fmt.Errorf("upsert channel: %w", err)
	}
	return c.ID, nil
}

func (p *PG) DeleteAlertChannel(ctx context.Context, id uuid.UUID) error {
	_, err := p.Pool.Exec(ctx, `DELETE FROM alert_channels WHERE id=$1`, id)
	if err != nil {
		return fmt.Errorf("delete channel: %w", err)
	}
	return nil
}

func (p *PG) ListAlertRules(ctx context.Context) ([]AlertRule, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT id,name,event_kind,source_match,severity_min,channel_ids,silence_sec,enabled,created_at
		FROM alert_rules ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("list alert rules: %w", err)
	}
	defer rows.Close()
	out := []AlertRule{}
	for rows.Next() {
		var r AlertRule
		if err := rows.Scan(&r.ID, &r.Name, &r.EventKind, &r.SourceMatch, &r.SeverityMin,
			&r.ChannelIDs, &r.SilenceSec, &r.Enabled, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan rule: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (p *PG) UpsertAlertRule(ctx context.Context, r AlertRule) (uuid.UUID, error) {
	if r.ID == uuid.Nil {
		r.ID = uuid.New()
	}
	if r.SilenceSec < 0 {
		r.SilenceSec = 0
	}
	if r.SeverityMin == "" {
		r.SeverityMin = "warning"
	}
	if r.SourceMatch == "" {
		r.SourceMatch = "*"
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO alert_rules (id,name,event_kind,source_match,severity_min,channel_ids,silence_sec,enabled)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (name) DO UPDATE SET
		  event_kind=EXCLUDED.event_kind, source_match=EXCLUDED.source_match,
		  severity_min=EXCLUDED.severity_min, channel_ids=EXCLUDED.channel_ids,
		  silence_sec=EXCLUDED.silence_sec, enabled=EXCLUDED.enabled`,
		r.ID, r.Name, r.EventKind, r.SourceMatch, r.SeverityMin,
		r.ChannelIDs, r.SilenceSec, r.Enabled)
	if err != nil {
		return uuid.Nil, fmt.Errorf("upsert rule: %w", err)
	}
	return r.ID, nil
}

func (p *PG) DeleteAlertRule(ctx context.Context, id uuid.UUID) error {
	_, err := p.Pool.Exec(ctx, `DELETE FROM alert_rules WHERE id=$1`, id)
	if err != nil {
		return fmt.Errorf("delete rule: %w", err)
	}
	return nil
}

func (p *PG) RecentAlertEvents(ctx context.Context, limit int) ([]AlertEvent, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := p.Pool.Query(ctx, fmt.Sprintf(`
		SELECT id,fired_at,event_kind,source,severity,title,body,payload,deliveries,suppressed,suppressed_reason
		FROM alert_events ORDER BY fired_at DESC LIMIT %d`, limit))
	if err != nil {
		return nil, fmt.Errorf("recent alerts: %w", err)
	}
	defer rows.Close()
	out := []AlertEvent{}
	for rows.Next() {
		var e AlertEvent
		if err := rows.Scan(&e.ID, &e.FiredAt, &e.EventKind, &e.Source, &e.Severity,
			&e.Title, &e.Body, &e.Payload, &e.Deliveries, &e.Suppressed, &e.SuppressedReason); err != nil {
			return nil, fmt.Errorf("scan event: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (p *PG) InsertAlertEvent(ctx context.Context, e AlertEvent) (int64, error) {
	if len(e.Payload) == 0 {
		e.Payload = []byte("{}")
	}
	if len(e.Deliveries) == 0 {
		e.Deliveries = []byte("[]")
	}
	row := p.Pool.QueryRow(ctx, `
		INSERT INTO alert_events (event_kind,source,severity,title,body,payload,deliveries,suppressed,suppressed_reason)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
		e.EventKind, e.Source, e.Severity, e.Title, e.Body, e.Payload,
		e.Deliveries, e.Suppressed, e.SuppressedReason)
	var id int64
	if err := row.Scan(&id); err != nil {
		return 0, fmt.Errorf("insert alert event: %w", err)
	}
	return id, nil
}

// CheckSilence returns true if (rule, source) is currently silenced and
// updates the ledger. Single round-trip via UPSERT + xmax inspection.
func (p *PG) CheckSilence(ctx context.Context, ruleID uuid.UUID, source string, window time.Duration) (silenced bool, err error) {
	row := p.Pool.QueryRow(ctx, `
		WITH upsert AS (
		  INSERT INTO alert_silence (rule_id, source, last_fired) VALUES ($1, $2, NOW())
		  ON CONFLICT (rule_id, source) DO UPDATE
		    SET last_fired = CASE
		      WHEN alert_silence.last_fired > NOW() - ($3::int * INTERVAL '1 second') THEN alert_silence.last_fired
		      ELSE NOW() END
		  RETURNING xmax::text::int <> 0 AS was_update, last_fired
		)
		SELECT was_update, last_fired FROM upsert`,
		ruleID, source, int(window.Seconds()))
	var wasUpdate bool
	var lastFired time.Time
	if err := row.Scan(&wasUpdate, &lastFired); err != nil {
		return false, fmt.Errorf("check silence: %w", err)
	}
	// Silenced when the existing row's last_fired was preserved (still in window).
	silenced = wasUpdate && time.Since(lastFired) < window
	return silenced, nil
}
