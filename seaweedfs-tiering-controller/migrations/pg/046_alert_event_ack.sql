-- ============================================================
-- 046: alert_events.acknowledged — operator-driven dismissal.
--
-- Once an event is acknowledged it disappears from the default
-- "recent alerts" feed and from the dashboard's Today's Attention
-- panel. Show-ignored toggles bring it back in the alerts UI.
-- The columns are append-only; we never null `acknowledged_at`
-- once set, so audits can still tell who silenced what and when.
-- ============================================================

ALTER TABLE alert_events
  ADD COLUMN IF NOT EXISTS acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acknowledged_by TEXT;

-- Partial index keeps the hot "unacknowledged recent events" query
-- (default Today's Attention + alerts page) cheap as the table grows.
CREATE INDEX IF NOT EXISTS idx_alert_events_unack
  ON alert_events (fired_at DESC)
  WHERE acknowledged = FALSE;
