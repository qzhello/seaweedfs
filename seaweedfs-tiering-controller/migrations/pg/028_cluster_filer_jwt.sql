-- ============================================================
-- 028: cluster.filer_jwt — optional Bearer token for filer HTTP auth.
-- ============================================================
--
-- When the cluster's filer is started with JWT enabled
-- (security.toml [jwt.signing.read] / [jwt.signing.write]), every HTTP
-- request to the filer must carry `Authorization: Bearer <jwt>` or it
-- gets 401 "wrong jwt". The controller's File Browser, upload, and
-- delete endpoints proxy to the filer's HTTP API, so they need to
-- forward a JWT.
--
-- We store a long-lived JWT the operator pasted in at cluster
-- registration time — generating tokens on the fly would require the
-- filer's signing secret, which is a strictly bigger trust surface to
-- store. Empty string means "filer is open / no JWT required".

ALTER TABLE clusters
    ADD COLUMN IF NOT EXISTS filer_jwt TEXT NOT NULL DEFAULT '';
