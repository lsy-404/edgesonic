import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON");
database.exec(`
  CREATE TABLE users (
    username TEXT PRIMARY KEY
  );
  CREATE TABLE identity_accounts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    auth_source TEXT NOT NULL,
    sso_issuer TEXT
  );
  INSERT INTO users (username) VALUES ('existing-user'), ('future-user');
  INSERT INTO identity_accounts (id, username) VALUES ('identity-existing', 'existing-user');
  INSERT INTO sessions (id, auth_source, sso_issuer) VALUES
    ('legacy-sso', 'sso', 'https://id.wuyilingwei.com'),
    ('current-sso', 'sso', 'https://id.voidcarve.com'),
    ('local-session', 'local', NULL);
`);

const initialMigrationUrl = new URL("../../worker/migrations/0039_personal_sso_identity_mapping.sql", import.meta.url);
const canonicalIssuerMigrationUrl = new URL("../../worker/migrations/0040_personal_sso_issuer_domain.sql", import.meta.url);
const initialMigration = readFileSync(initialMigrationUrl, "utf8");
const canonicalIssuerMigration = readFileSync(canonicalIssuerMigrationUrl, "utf8");
database.exec(initialMigration);
database.exec(canonicalIssuerMigration);
database.exec(canonicalIssuerMigration);

const existing = database.prepare(
  "SELECT username FROM oidc_identities WHERE issuer = ? AND subject = ?",
).get("https://id.voidcarve.com", "identity-existing") as { username: string };
assert.equal(existing.username, "existing-user");

database.prepare(
  "INSERT INTO identity_accounts (id, username) VALUES (?, ?)",
).run("identity-future", "future-user");
const future = database.prepare(
  "SELECT username FROM oidc_identities WHERE issuer = ? AND subject = ?",
).get("https://id.voidcarve.com", "identity-future") as { username: string };
assert.equal(future.username, "future-user");

const legacySessions = database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE id = 'legacy-sso'").get() as { count: number };
const retainedSessions = database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE id IN ('current-sso', 'local-session')").get() as { count: number };
assert.equal(legacySessions.count, 0);
assert.equal(retainedSessions.count, 2);

const count = database.prepare("SELECT COUNT(*) AS count FROM oidc_identities").get() as { count: number };
assert.equal(count.count, 2);

console.log("personal SSO identity mappings move to the canonical issuer and cover future accounts");
