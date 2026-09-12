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
  INSERT INTO users (username) VALUES ('existing-user'), ('future-user');
  INSERT INTO identity_accounts (id, username) VALUES ('identity-existing', 'existing-user');
`);

const migrationUrl = new URL("../../worker/migrations/0039_personal_sso_identity_mapping.sql", import.meta.url);
const migration = readFileSync(migrationUrl, "utf8");
database.exec(migration);
database.exec(migration);

const existing = database.prepare(
  "SELECT username FROM oidc_identities WHERE issuer = ? AND subject = ?",
).get("https://id.wuyilingwei.com", "identity-existing") as { username: string };
assert.equal(existing.username, "existing-user");

database.prepare(
  "INSERT INTO identity_accounts (id, username) VALUES (?, ?)",
).run("identity-future", "future-user");
const future = database.prepare(
  "SELECT username FROM oidc_identities WHERE issuer = ? AND subject = ?",
).get("https://id.wuyilingwei.com", "identity-future") as { username: string };
assert.equal(future.username, "future-user");

const count = database.prepare("SELECT COUNT(*) AS count FROM oidc_identities").get() as { count: number };
assert.equal(count.count, 2);

console.log("personal SSO identity mappings are idempotent and cover future accounts");
