-- Per-cluster `weed` binary path. Empty string falls back to the global
-- resolution chain ($WEED_BIN env, $PATH, relative defaults) implemented
-- in internal/seaweed/shell_runner.go.
--
-- Operators that maintain multiple clusters (mixed weed versions, or weed
-- binaries shipped alongside the cluster install) can pin a specific
-- absolute path here so the controller's `weed shell` invocations against
-- that cluster use the matching binary instead of whatever the controller
-- process picked up at boot.

ALTER TABLE clusters
  ADD COLUMN IF NOT EXISTS weed_bin_path TEXT NOT NULL DEFAULT '';
