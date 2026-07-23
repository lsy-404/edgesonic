// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

//
// Coverage for the email feature: single-use token generation/
// consumption (utils/email.ts, including the email_tokens self-heal
// rebuild), self-service registration gated by open_registration + Resend
// configuration, password-reset request/confirm gated by the independent
// allow_email_password_reset switch, the two-step email-change flow
// (current-password verification + new-mailbox confirmation before the
// address takes effect), and the super-admin-only email template gate.
//
// Run: npx tsx test/internal/email_auth_flow.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { webLoginRoutes, edgesonicAuthRoutes } from "../../worker/src/endpoints/edgesonic/auth";
import { featuresRoutes } from "../../worker/src/endpoints/edgesonic/features";
import { createEmailToken, consumeEmailToken, consumeEmailChangeToken } from "../../worker/src/utils/email";
import { sha256 } from "../../worker/src/auth";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeD1(sqlite: DatabaseSync): any {
  function prepare(query: string) {
    const stmt = sqlite.prepare(query);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let boundArgs: any[] = [];
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bind(...args: any[]) { boundArgs = args; return this; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async first<T = any>(): Promise<T | null> {
        return (stmt.get(...boundArgs) ?? null) as T | null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async all<T = any>(): Promise<{ results: T[]; success: true; meta: any }> {
        return { results: stmt.all(...boundArgs) as T[], success: true, meta: {} };
      },
      async run() {
        const info = stmt.run(...boundArgs);
        return { success: true, meta: { changes: Number(info.changes ?? 0) } };
      },
    };
  }
  return { prepare };
}

function buildDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE users (
      username TEXT PRIMARY KEY, master_password TEXT NOT NULL, level INTEGER DEFAULT 1,
      enabled INTEGER DEFAULT 1, email TEXT, email_verified INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE UNIQUE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
      user_agent TEXT, expires_at INTEGER NOT NULL, created_at INTEGER DEFAULT 0
    );
    CREATE TABLE features (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0, description TEXT, updated_at INTEGER);
    CREATE TABLE feature_strings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', description TEXT, updated_at INTEGER);
    CREATE TABLE external_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at INTEGER);
    CREATE TABLE email_tokens (
      token TEXT PRIMARY KEY, username TEXT NOT NULL, purpose TEXT NOT NULL,
      new_email TEXT, expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER DEFAULT 0
    );
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL, permission TEXT NOT NULL, enabled INTEGER DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    INSERT INTO features (key, value) VALUES ('open_registration', 0), ('allow_email_password_reset', 0);
    -- Mirrors Schema.sql's fresh-install seed: /features/updateString 404s
    -- on a key whose row doesn't already exist (UPDATE affecting 0 rows).
    INSERT INTO feature_strings (key, value) VALUES
      ('resend_from_email', ''), ('resend_from_name', 'EdgeSonic'),
      ('login_notice_text', ''), ('login_background_url', ''),
      ('email_tpl_verify_subject', 'Verify your email'), ('email_tpl_verify_body', 'Click {{link}}'),
      ('email_tpl_reset_subject', 'Reset your password'), ('email_tpl_reset_body', 'Click {{link}}'),
      ('email_tpl_change_subject', 'Confirm new email'), ('email_tpl_change_body', 'Click {{link}}');
  `);
  return sqlite;
}

function enableRegistration(sqlite: DatabaseSync, opts: { emailConfigured: boolean }) {
  sqlite.prepare("UPDATE features SET value = 1 WHERE key = 'open_registration'").run();
  if (opts.emailConfigured) enableEmail(sqlite);
}

function enableEmail(sqlite: DatabaseSync) {
  sqlite.prepare("INSERT OR IGNORE INTO external_secrets (key, value) VALUES ('resend_api_key', 'test_key')").run();
  sqlite.prepare("UPDATE feature_strings SET value = 'noreply@test.com' WHERE key = 'resend_from_email'").run();
}

function enablePasswordReset(sqlite: DatabaseSync) {
  sqlite.prepare("UPDATE features SET value = 1 WHERE key = 'allow_email_password_reset'").run();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeApp(sqlite: DatabaseSync, extraEnv: Record<string, string> = {}): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any }>();
  app.route("/", webLoginRoutes);
  const env = { DB: makeD1(sqlite), INSTANCE_ID: "test", ...extraEnv };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async post(path: string, body: unknown): Promise<any> {
      return app.fetch(
        new Request(`http://test${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        env as any,
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async get(path: string): Promise<any> {
      return app.fetch(new Request(`http://test${path}`), env as any);
    },
  };
}

// Session-gated routes (emailChange/request, features/updateString) skip
// real cookie/session auth and inject the caller directly — same pattern as
// test/internal/demo_mode.test.ts's makeFeaturesApp / auth_cookie_session's
// composed app.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSessionApp(sqlite: DatabaseSync, caller: { username: string; level: number }, extraEnv: Record<string, string> = {}): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.route("/", webLoginRoutes);
  app.use("/edgesonic/*", async (c, next) => { c.set("user", caller); return next(); });
  app.route("/edgesonic", edgesonicAuthRoutes);
  app.route("/edgesonic", featuresRoutes);
  const env = { DB: makeD1(sqlite), INSTANCE_ID: "test", ...extraEnv };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async post(path: string, body: unknown): Promise<any> {
      return app.fetch(
        new Request(`http://test${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        env as any,
      );
    },
  };
}

async function main() {
  const now = Math.floor(Date.now() / 1000);

  // Must run FIRST: ensureEmailTokensTable's "already ensured" flag is a
  // plain module-level singleton (one D1 per Worker isolate in production,
  // so this is fine there) — once any other scenario below has touched
  // email_tokens, this process-wide flag is set and the self-heal probe
  // would short-circuit before ever inspecting this scenario's own fresh
  // older-shape table.
  console.log("email_tokens self-heal: older table shape gets rebuilt on first use:");
  {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE users (username TEXT PRIMARY KEY, master_password TEXT, level INTEGER DEFAULT 1, enabled INTEGER DEFAULT 1);
      CREATE TABLE email_tokens (
        token TEXT PRIMARY KEY, username TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
        expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER DEFAULT 0
      );
      INSERT INTO users (username, master_password) VALUES ('alice', 'hash');
    `);
    const db = makeD1(sqlite);
    const token = await createEmailToken(db, "alice", "change_email", 3600, "alice-new@example.com");
    const ddl = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='email_tokens'").get() as { sql: string };
    assert(/change_email/.test(ddl.sql), "table rebuilt to the new shape (purpose CHECK includes change_email)");
    assert(/new_email/.test(ddl.sql), "table rebuilt to the new shape (new_email column present)");
    const owner = await consumeEmailChangeToken(db, token);
    assert(owner?.username === "alice" && owner.newEmail === "alice-new@example.com", "token round-trips new_email correctly post-rebuild");
  }

  console.log("\ncreateEmailToken / consumeEmailToken round trip:");
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    const token = await createEmailToken(db, "alice", "verify", 3600);
    const owner = await consumeEmailToken(db, token, "verify");
    assert(owner === "alice", `first consume returns owning username (got ${owner})`);
    const again = await consumeEmailToken(db, token, "verify");
    assert(again === null, "second consume of the same token fails (single-use)");
  }
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    const expired = await createEmailToken(db, "alice", "reset", -10);
    const owner = await consumeEmailToken(db, expired, "reset");
    assert(owner === null, "expired token cannot be consumed");
  }
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    const token = await createEmailToken(db, "alice", "reset", 3600);
    const owner = await consumeEmailToken(db, token, "verify");
    assert(owner === null, "token consumed under the wrong purpose fails");
  }

  console.log("\nPOST /edgesonic/auth/register — gated by open_registration:");
  {
    const sqlite = buildDb(); // open_registration stays 0
    const { post } = makeApp(sqlite);
    const r = await post("/edgesonic/auth/register", { username: "newuser", email: "new@example.com", password: "longpassword1" });
    assert(r.status === 403, `403 when open_registration is off (got ${r.status})`);
  }

  console.log("\nPOST /edgesonic/auth/register — gated by Resend configuration:");
  {
    const sqlite = buildDb();
    enableRegistration(sqlite, { emailConfigured: false });
    const { post } = makeApp(sqlite);
    const r = await post("/edgesonic/auth/register", { username: "newuser", email: "new@example.com", password: "longpassword1" });
    assert(r.status === 403, `403 when Resend is not configured (got ${r.status})`);
  }

  console.log("\nPOST /edgesonic/auth/register — happy path + validation:");
  {
    const sqlite = buildDb();
    enableRegistration(sqlite, { emailConfigured: true });
    const { post } = makeApp(sqlite);

    const bad1 = await post("/edgesonic/auth/register", { username: "ab", email: "new@example.com", password: "longpassword1" });
    assert(bad1.status === 400, `400 on too-short username (got ${bad1.status})`);

    const bad2 = await post("/edgesonic/auth/register", { username: "newuser", email: "not-an-email", password: "longpassword1" });
    assert(bad2.status === 400, `400 on invalid email (got ${bad2.status})`);

    const bad3 = await post("/edgesonic/auth/register", { username: "newuser", email: "new@example.com", password: "short" });
    assert(bad3.status === 400, `400 on too-short password (got ${bad3.status})`);

    const ok = await post("/edgesonic/auth/register", { username: "newuser", email: "New@Example.com", password: "longpassword1" });
    const okBody = await ok.json() as { ok: boolean; username?: string };
    assert(ok.status === 200 && okBody.ok, `registration succeeds (got ${ok.status})`);

    const row = sqlite.prepare("SELECT master_password, email, email_verified, level, enabled FROM users WHERE username = ?").get("newuser") as
      { master_password: string; email: string; email_verified: number; level: number; enabled: number } | undefined;
    assert(!!row, "user row created");
    assert(row?.email === "new@example.com", `email stored lower-cased (got ${row?.email})`);
    assert(row?.email_verified === 0, "email_verified starts false");
    assert(row?.level === 1 && row?.enabled === 1, "new account is a normal enabled level-1 user");
    assert(row?.master_password === await sha256("longpassword1"), "password hash matches sha256(password)");

    const dupeUsername = await post("/edgesonic/auth/register", { username: "newuser", email: "other@example.com", password: "longpassword1" });
    assert(dupeUsername.status === 409, `409 on duplicate username (got ${dupeUsername.status})`);

    const dupeEmail = await post("/edgesonic/auth/register", { username: "another", email: "new@example.com", password: "longpassword1" });
    assert(dupeEmail.status === 409, `409 on duplicate email (got ${dupeEmail.status})`);

    // Login now works with the self-chosen password (registration doesn't
    // open a session itself — the SPA calls login() right after).
    const login = await post("/edgesonic/auth/login", { username: "newuser", password: "longpassword1" });
    assert(login.status === 200, `freshly registered account can log in (got ${login.status})`);
  }

  console.log("\nPOST /edgesonic/auth/register — disabled in demo mode regardless of flags:");
  {
    const sqlite = buildDb();
    enableRegistration(sqlite, { emailConfigured: true });
    const { post } = makeApp(sqlite, { DEMO_MODE: "1" });
    const r = await post("/edgesonic/auth/register", { username: "demouser", email: "demo@example.com", password: "longpassword1" });
    assert(r.status === 403, `403 in demo mode even with registration+email configured (got ${r.status})`);
  }

  console.log("\nPOST /edgesonic/auth/passwordReset/request — gated by allow_email_password_reset:");
  {
    const sqlite = buildDb(); // allow_email_password_reset stays 0 (default)
    sqlite.prepare(
      "INSERT INTO users (username, master_password, level, enabled, email, created_at, updated_at) VALUES ('alice', 'hash', 1, 1, 'alice@example.com', ?, ?)"
    ).run(now, now);
    const { post } = makeApp(sqlite);
    const r = await post("/edgesonic/auth/passwordReset/request", { emailOrUsername: "alice@example.com" });
    const body = await r.json() as { ok: boolean };
    assert(r.status === 200 && body.ok, "still returns ok:true when the switch is off (no enumeration)");
    const tokenCount = sqlite.prepare("SELECT COUNT(*) AS n FROM email_tokens").get() as { n: number };
    assert(tokenCount.n === 0, "no reset token created while allow_email_password_reset is off");
  }

  console.log("\nPOST /edgesonic/auth/passwordReset/request + confirm:");
  {
    const sqlite = buildDb();
    enablePasswordReset(sqlite);
    sqlite.prepare(
      "INSERT INTO users (username, master_password, level, enabled, email, created_at, updated_at) VALUES ('alice', ?, 1, 1, 'alice@example.com', ?, ?)"
    ).run(await sha256("oldpassword1"), now, now);
    sqlite.prepare(
      "INSERT INTO sessions (id, username, token, expires_at, created_at) VALUES ('s1', 'alice', 'tok1', ?, ?)"
    ).run(now + 86400, now);
    const { post } = makeApp(sqlite);

    const unknown = await post("/edgesonic/auth/passwordReset/request", { emailOrUsername: "nobody@example.com" });
    const unknownBody = await unknown.json() as { ok: boolean };
    assert(unknown.status === 200 && unknownBody.ok, "unknown account still returns ok:true (no enumeration)");
    const noToken = sqlite.prepare("SELECT COUNT(*) AS n FROM email_tokens").get() as { n: number };
    assert(noToken.n === 0, "no token row created for an unknown account");

    const req = await post("/edgesonic/auth/passwordReset/request", { emailOrUsername: "alice@example.com" });
    const reqBody = await req.json() as { ok: boolean };
    assert(req.status === 200 && reqBody.ok, "reset request for a real account returns ok:true");
    const tokenRow = sqlite.prepare("SELECT token FROM email_tokens WHERE username = 'alice' AND purpose = 'reset'").get() as { token: string } | undefined;
    assert(!!tokenRow, "reset token row created");

    const confirm = await post("/edgesonic/auth/passwordReset/confirm", { token: tokenRow!.token, newPassword: "newpassword1" });
    const confirmBody = await confirm.json() as { ok: boolean };
    assert(confirm.status === 200 && confirmBody.ok, "confirm with a valid token succeeds");

    const updated = sqlite.prepare("SELECT master_password FROM users WHERE username = 'alice'").get() as { master_password: string };
    assert(updated.master_password === await sha256("newpassword1"), "password hash updated to the new password");
    const sessionsLeft = sqlite.prepare("SELECT COUNT(*) AS n FROM sessions WHERE username = 'alice'").get() as { n: number };
    assert(sessionsLeft.n === 0, "all prior sessions invalidated by the reset");

    const reuse = await post("/edgesonic/auth/passwordReset/confirm", { token: tokenRow!.token, newPassword: "anotherpassword1" });
    assert(reuse.status === 400, `re-using a consumed reset token fails (got ${reuse.status})`);
  }

  console.log("\nPOST /edgesonic/auth/passwordReset/request — never sends in demo mode (even with the switch on):");
  {
    const sqlite = buildDb();
    enablePasswordReset(sqlite);
    sqlite.prepare(
      "INSERT INTO users (username, master_password, level, enabled, email, created_at, updated_at) VALUES ('alice', 'hash', 1, 1, 'alice@example.com', ?, ?)"
    ).run(now, now);
    const { post } = makeApp(sqlite, { DEMO_MODE: "1" });
    const r = await post("/edgesonic/auth/passwordReset/request", { emailOrUsername: "alice@example.com" });
    const body = await r.json() as { ok: boolean };
    assert(r.status === 200 && body.ok, "still returns ok:true in demo mode");
    const tokenCount = sqlite.prepare("SELECT COUNT(*) AS n FROM email_tokens").get() as { n: number };
    assert(tokenCount.n === 0, "no reset token created in demo mode (never sends)");
  }

  console.log("\nPOST /edgesonic/auth/emailVerify/confirm:");
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    sqlite.prepare(
      "INSERT INTO users (username, master_password, level, enabled, email, email_verified, created_at, updated_at) VALUES ('alice', 'hash', 1, 1, 'alice@example.com', 0, ?, ?)"
    ).run(now, now);
    const token = await createEmailToken(db, "alice", "verify", 3600);
    const { post } = makeApp(sqlite);

    const bad = await post("/edgesonic/auth/emailVerify/confirm", { token: "not-a-real-token" });
    assert(bad.status === 400, `invalid token 400 (got ${bad.status})`);

    const r = await post("/edgesonic/auth/emailVerify/confirm", { token });
    const body = await r.json() as { ok: boolean };
    assert(r.status === 200 && body.ok, "valid token verifies successfully");
    const row = sqlite.prepare("SELECT email_verified FROM users WHERE username = 'alice'").get() as { email_verified: number };
    assert(row.email_verified === 1, "email_verified flipped to 1");
  }

  console.log("\nGET /edgesonic/auth/loginConfig:");
  {
    const sqlite = buildDb(); // registration off, reset off, email unconfigured
    const { get } = makeApp(sqlite);
    const r = await get("/edgesonic/auth/loginConfig");
    const body = await r.json() as { ok: boolean; registrationEnabled: boolean; passwordResetEnabled: boolean; emailEnabled: boolean; isDemo: boolean };
    assert(r.status === 200 && body.ok, "loginConfig responds ok");
    assert(body.registrationEnabled === false, "registrationEnabled false when everything is off");
    assert(body.passwordResetEnabled === false, "passwordResetEnabled false when everything is off");
    assert(body.emailEnabled === false, "emailEnabled false when Resend is unconfigured");
    assert(body.isDemo === false, "isDemo false by default");
  }
  {
    const sqlite = buildDb();
    enableRegistration(sqlite, { emailConfigured: false });
    const { get } = makeApp(sqlite);
    const body = await (await get("/edgesonic/auth/loginConfig")).json() as { registrationEnabled: boolean; emailEnabled: boolean };
    assert(body.registrationEnabled === false, "registrationEnabled stays false without email configured, even with the flag on");
  }
  {
    // The two switches are independent — registration on, reset off.
    const sqlite = buildDb();
    enableRegistration(sqlite, { emailConfigured: true });
    const { get } = makeApp(sqlite);
    const body = await (await get("/edgesonic/auth/loginConfig")).json() as { registrationEnabled: boolean; passwordResetEnabled: boolean };
    assert(body.registrationEnabled === true, "registrationEnabled true with the flag + email configured");
    assert(body.passwordResetEnabled === false, "passwordResetEnabled stays false — it has its own independent switch");
  }
  {
    // The reverse — reset on, registration off.
    const sqlite = buildDb();
    enableEmail(sqlite);
    enablePasswordReset(sqlite);
    const { get } = makeApp(sqlite);
    const body = await (await get("/edgesonic/auth/loginConfig")).json() as { registrationEnabled: boolean; passwordResetEnabled: boolean };
    assert(body.registrationEnabled === false, "registrationEnabled stays false — open_registration is still off");
    assert(body.passwordResetEnabled === true, "passwordResetEnabled true once its own switch + email are on");
  }
  {
    const sqlite = buildDb();
    enableRegistration(sqlite, { emailConfigured: true });
    enablePasswordReset(sqlite);
    sqlite.prepare("UPDATE feature_strings SET value = 'hello' WHERE key = 'login_notice_text'").run();
    const { get } = makeApp(sqlite, { DEMO_MODE: "1" });
    const body = await (await get("/edgesonic/auth/loginConfig")).json() as
      { registrationEnabled: boolean; passwordResetEnabled: boolean; emailEnabled: boolean; isDemo: boolean; noticeText: string };
    assert(body.registrationEnabled === true, "registrationEnabled true once both the flag and email are configured");
    assert(body.passwordResetEnabled === true, "passwordResetEnabled true once both its flag and email are configured");
    assert(body.emailEnabled === true, "emailEnabled true once Resend is configured");
    assert(body.isDemo === true, "isDemo reflects DEMO_MODE env");
    assert(body.noticeText === "hello", "noticeText passes through feature_strings");
  }

  console.log("\nPOST /edgesonic/auth/emailChange/request:");
  {
    const sqlite = buildDb();
    enableEmail(sqlite);
    sqlite.prepare(
      "INSERT INTO users (username, master_password, level, enabled, email, created_at, updated_at) VALUES ('alice', ?, 1, 1, 'alice@old.com', ?, ?)"
    ).run(await sha256("correctpw1"), now, now);
    sqlite.prepare(
      "INSERT INTO users (username, master_password, level, enabled, email, created_at, updated_at) VALUES ('bob', 'hash', 1, 1, 'bob@example.com', ?, ?)"
    ).run(now, now);

    const guest = makeSessionApp(sqlite, { username: "anon", level: 0 });
    const guestR = await guest.post("/edgesonic/auth/emailChange/request", { currentPassword: "correctpw1", newEmail: "new@example.com" });
    assert(guestR.status === 403, `guest (level 0) blocked (got ${guestR.status})`);

    const demoApp = makeSessionApp(sqlite, { username: "alice", level: 1 }, { DEMO_MODE: "1" });
    const demoR = await demoApp.post("/edgesonic/auth/emailChange/request", { currentPassword: "correctpw1", newEmail: "new@example.com" });
    assert(demoR.status === 403, `demo mode blocked (got ${demoR.status})`);

    const app = makeSessionApp(sqlite, { username: "alice", level: 1 });

    const wrongPw = await app.post("/edgesonic/auth/emailChange/request", { currentPassword: "wrongpw", newEmail: "new@example.com" });
    assert(wrongPw.status === 401, `wrong current password → 401 (got ${wrongPw.status})`);

    const clash = await app.post("/edgesonic/auth/emailChange/request", { currentPassword: "correctpw1", newEmail: "bob@example.com" });
    assert(clash.status === 409, `newEmail already in use → 409 (got ${clash.status})`);

    const bad = await app.post("/edgesonic/auth/emailChange/request", { currentPassword: "correctpw1", newEmail: "not-an-email" });
    assert(bad.status === 400, `invalid newEmail → 400 (got ${bad.status})`);

    const ok = await app.post("/edgesonic/auth/emailChange/request", { currentPassword: "correctpw1", newEmail: "New@Example.com" });
    const okBody = await ok.json() as { ok: boolean };
    assert(ok.status === 200 && okBody.ok, `valid request succeeds (got ${ok.status})`);

    const stillOld = sqlite.prepare("SELECT email FROM users WHERE username = 'alice'").get() as { email: string };
    assert(stillOld.email === "alice@old.com", "users.email is NOT changed by the request step — only confirm writes it");

    const tokenRow = sqlite.prepare(
      "SELECT token, new_email FROM email_tokens WHERE username = 'alice' AND purpose = 'change_email'"
    ).get() as { token: string; new_email: string } | undefined;
    assert(!!tokenRow && tokenRow.new_email === "new@example.com", "change_email token created carrying the normalized new address");
  }

  console.log("\nPOST /edgesonic/auth/emailChange/confirm:");
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    sqlite.prepare(
      "INSERT INTO users (username, master_password, level, enabled, email, email_verified, created_at, updated_at) VALUES ('alice', 'hash', 1, 1, 'alice@old.com', 0, ?, ?)"
    ).run(now, now);
    const { post } = makeApp(sqlite);

    const bad = await post("/edgesonic/auth/emailChange/confirm", { token: "not-a-real-token" });
    assert(bad.status === 400, `invalid token → 400 (got ${bad.status})`);

    const token = await createEmailToken(db, "alice", "change_email", 24 * 60 * 60, "alice@new.com");
    const ok = await post("/edgesonic/auth/emailChange/confirm", { token });
    const okBody = await ok.json() as { ok: boolean; username?: string; email?: string };
    assert(ok.status === 200 && okBody.ok && okBody.email === "alice@new.com", `confirm succeeds and echoes the new address (got ${ok.status})`);

    const row = sqlite.prepare("SELECT email, email_verified FROM users WHERE username = 'alice'").get() as { email: string; email_verified: number };
    assert(row.email === "alice@new.com", "users.email updated to the confirmed address");
    assert(row.email_verified === 1, "email_verified set to 1 — confirming IS the ownership proof, no separate verify step needed");

    const reuse = await post("/edgesonic/auth/emailChange/confirm", { token });
    assert(reuse.status === 400, `re-using a consumed change token fails (got ${reuse.status})`);
  }
  {
    // Race guard: the address gets claimed by someone else between request
    // and confirm — confirm must reject rather than silently stealing it.
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    sqlite.prepare(
      "INSERT INTO users (username, master_password, level, enabled, email, created_at, updated_at) VALUES ('alice', 'hash', 1, 1, 'alice@old.com', ?, ?)"
    ).run(now, now);
    const token = await createEmailToken(db, "alice", "change_email", 24 * 60 * 60, "contested@example.com");
    sqlite.prepare(
      "INSERT INTO users (username, master_password, level, enabled, email, created_at, updated_at) VALUES ('bob', 'hash', 1, 1, 'contested@example.com', ?, ?)"
    ).run(now, now);
    const { post } = makeApp(sqlite);
    const r = await post("/edgesonic/auth/emailChange/confirm", { token });
    assert(r.status === 409, `confirm rejects when the address was claimed in the meantime (got ${r.status})`);
    const aliceRow = sqlite.prepare("SELECT email FROM users WHERE username = 'alice'").get() as { email: string };
    assert(aliceRow.email === "alice@old.com", "alice's email is untouched after the rejected confirm");
  }

  console.log("\nPOST /edgesonic/features/updateString — email templates are super-admin only:");
  {
    const sqlite = buildDb();
    // Level 2 WITH manage_settings granted — still not enough for templates.
    sqlite.prepare("INSERT INTO user_permissions (level, permission, enabled) VALUES (2, 'manage_settings', 1)").run();
    const admin = makeSessionApp(sqlite, { username: "admin2", level: 2 });
    const adminR = await admin.post("/edgesonic/features/updateString", { key: "email_tpl_verify_subject", value: "New subject" });
    assert(adminR.status === 403, `level 2 manage_settings admin blocked from editing templates (got ${adminR.status})`);

    // Same admin CAN edit a non-template string feature.
    const nonTpl = await admin.post("/edgesonic/features/updateString", { key: "resend_from_email", value: "a@b.com" });
    assert(nonTpl.status !== 403, `level 2 manage_settings admin can still edit non-template keys (got ${nonTpl.status})`);

    // Level 3 super-admin — allowed (manage_settings short-circuits true).
    const superAdmin = makeSessionApp(sqlite, { username: "root", level: 3 });
    const superR = await superAdmin.post("/edgesonic/features/updateString", {
      key: "email_tpl_verify_subject", value: "New subject with {{link}}... actually subjects don't need it, just checking write access",
    });
    assert(superR.status === 200, `level 3 super-admin can edit templates (got ${superR.status})`);
    const row = sqlite.prepare("SELECT value FROM feature_strings WHERE key = 'email_tpl_verify_subject'").get() as { value: string };
    assert(row.value.startsWith("New subject"), "template value actually persisted");

    // Body validation: must contain {{link}}.
    const missingLink = await superAdmin.post("/edgesonic/features/updateString", { key: "email_tpl_reset_body", value: "no placeholder here" });
    assert(missingLink.status === 400, `template body without {{link}} rejected (got ${missingLink.status})`);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
