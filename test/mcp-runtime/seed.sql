INSERT OR REPLACE INTO users (username, master_password, level, enabled, activation_status)
VALUES ('runtime-test-user', 'unused-local-fixture', 3, 1, 'permanent');
INSERT OR REPLACE INTO sessions (id, username, token, auth_source, expires_at)
VALUES ('mcp-runtime-session', 'runtime-test-user', 'mcp-runtime-fixture-session', 'local', unixepoch() + 3600);
