INSERT OR IGNORE INTO oidc_identities (issuer, subject, username, created_at, last_login_at)
SELECT 'https://id.voidcarve.com', subject, username, created_at, last_login_at
FROM oidc_identities
WHERE issuer = 'https://id.wuyilingwei.com';

DELETE FROM oidc_identities
WHERE issuer = 'https://id.wuyilingwei.com';

DROP TRIGGER IF EXISTS map_personal_identity_to_edgesonic;

CREATE TRIGGER map_personal_identity_to_edgesonic
AFTER INSERT ON identity_accounts
BEGIN
  INSERT OR IGNORE INTO oidc_identities (issuer, subject, username, created_at, last_login_at)
  VALUES ('https://id.voidcarve.com', NEW.id, NEW.username, unixepoch(), unixepoch());
END;

DELETE FROM sessions
WHERE auth_source = 'sso'
  AND sso_issuer = 'https://id.wuyilingwei.com';
