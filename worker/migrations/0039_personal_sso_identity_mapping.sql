CREATE TABLE IF NOT EXISTS oidc_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_login_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (issuer, subject),
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_oidc_identities_username
ON oidc_identities(username);

INSERT OR IGNORE INTO oidc_identities (issuer, subject, username, created_at, last_login_at)
SELECT 'https://id.wuyilingwei.com', id, username, unixepoch(), unixepoch()
FROM identity_accounts;

CREATE TRIGGER IF NOT EXISTS map_personal_identity_to_edgesonic
AFTER INSERT ON identity_accounts
BEGIN
  INSERT OR IGNORE INTO oidc_identities (issuer, subject, username, created_at, last_login_at)
  VALUES ('https://id.wuyilingwei.com', NEW.id, NEW.username, unixepoch(), unixepoch());
END;
