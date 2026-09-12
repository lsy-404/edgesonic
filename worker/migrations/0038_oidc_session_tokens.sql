ALTER TABLE sessions ADD COLUMN sso_refresh_token TEXT;
ALTER TABLE sessions ADD COLUMN sso_id_token TEXT;
ALTER TABLE sessions ADD COLUMN sso_token_expires_at INTEGER;
ALTER TABLE sessions ADD COLUMN sso_refresh_expires_at INTEGER;
ALTER TABLE sessions ADD COLUMN sso_issuer TEXT;
ALTER TABLE sessions ADD COLUMN sso_client_id TEXT;
ALTER TABLE sessions ADD COLUMN sso_dpop_key TEXT;
