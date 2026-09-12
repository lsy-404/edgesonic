// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { authMiddleware } from "../../worker/src/auth";
import { webLoginRoutes } from "../../worker/src/endpoints/edgesonic/auth";
import { resolveSsoPolicy } from "../../worker/src/utils/ssoPolicy";

declare global { type D1Database = unknown; type Env = unknown; }

function makeD1(sqlite: DatabaseSync) {
  function prepare(query: string) {
    const statement = sqlite.prepare(query);
    let values: unknown[] = [];
    return {
      bind(...next: unknown[]) { values = next; return this; },
      async first<T>(): Promise<T | null> { return (statement.get(...values) ?? null) as T | null; },
      async all<T>(): Promise<{ results: T[]; success: true; meta: object }> {
        return { results: statement.all(...values) as T[], success: true, meta: {} };
      },
      async run() {
        const result = statement.run(...values);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
  }
  return { prepare };
}

function buildDatabase(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE users (
      username TEXT PRIMARY KEY,
      master_password TEXT NOT NULL,
      level INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      activation_status TEXT NOT NULL DEFAULT 'permanent',
      activated_until INTEGER,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      auth_source TEXT NOT NULL DEFAULT 'local' CHECK (auth_source IN ('local', 'sso')),
      user_agent TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE api_keys (api_key TEXT PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE subsonic_credentials (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, password TEXT NOT NULL,
      stream_proxy_strategy TEXT, last_used INTEGER, expires_at INTEGER
    );
    CREATE TABLE guest_tokens (token TEXT PRIMARY KEY, expires_at INTEGER);
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL, permission TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
      max_rph INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (level, permission)
    );
    CREATE TABLE features (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE feature_strings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE external_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
    INSERT INTO users (username, master_password, level, enabled) VALUES ('alice', 'x', 1, 1);
    INSERT INTO sessions (id, username, token, auth_source, expires_at)
      VALUES ('local-session', 'alice', 'local-token', 'local', unixepoch() + 3600);
    INSERT INTO sessions (id, username, token, auth_source, expires_at)
      VALUES ('sso-session', 'alice', 'sso-token', 'sso', unixepoch() + 3600);
    INSERT INTO api_keys (api_key, username) VALUES ('alice-key', 'alice');
    INSERT INTO features (key, value) VALUES
      ('open_registration', 1), ('allow_email_password_reset', 1), ('enable_activation', 0);
    INSERT INTO feature_strings (key, value) VALUES
      ('login_notice_text', ''), ('login_background_url', ''),
      ('registration_gate_mode', 'all'), ('resend_from_email', '');
    INSERT INTO external_secrets (key, value) VALUES ('resend_api_key', '');
  `);
  return sqlite;
}

function configuredEnv(sqlite: DatabaseSync) {
  return {
    DB: makeD1(sqlite),
    INSTANCE_ID: "test-instance",
    SSO_MODE: "optional",
    SSO_ISSUER: "https://identity.example",
    SSO_CLIENT_ID: "edgesonic-client",
    SSO_CLIENT_SECRET: "client-secret",
    SSO_PROVIDER_NAME: "Identity",
  };
}

function makeApp(env: ReturnType<typeof configuredEnv>) {
  const app = new Hono<{ Bindings: typeof env; Variables: Record<string, unknown> }>();
  app.route("/", webLoginRoutes);
  app.use("/rest/*", authMiddleware);
  app.use("/edgesonic/*", authMiddleware);
  app.get("/rest/ping", (c) => c.json({ ok: true }));
  app.get("/edgesonic/protected", (c) => c.json({ ok: true, source: c.get("sessionAuthSource") }));
  return app;
}

async function request(app: ReturnType<typeof makeApp>, env: ReturnType<typeof configuredEnv>, path: string, cookie?: string) {
  return app.fetch(new Request(`https://music.example${path}`, {
    headers: cookie ? { Cookie: `edgesonic_session=${cookie}` } : undefined,
  }), env);
}

async function main() {
  const defaultPolicy = resolveSsoPolicy({}, "https://music.example/login");
  assert.equal(defaultPolicy.mode, "disabled");
  assert.equal(defaultPolicy.localAuthenticationAllowed, true);

  const optionalMissing = resolveSsoPolicy({ SSO_MODE: "optional" }, "https://music.example/login");
  assert.equal(optionalMissing.failClosed, false);
  assert.equal(optionalMissing.configured, false);
  assert.equal(optionalMissing.localAuthenticationAllowed, true);

  const requiredMissing = resolveSsoPolicy({ SSO_MODE: "required" }, "https://music.example/login");
  assert.equal(requiredMissing.failClosed, true);
  assert.equal(requiredMissing.localAuthenticationAllowed, false);
  assert.equal(resolveSsoPolicy({ SSO_MODE: "invalid" }, "https://music.example/login").failClosed, true);

  const sqlite = buildDatabase();
  const env = configuredEnv(sqlite);
  const app = makeApp(env);

  env.SSO_MODE = "disabled";
  assert.equal((await request(app, env, "/edgesonic/protected", "local-token")).status, 200);
  assert.equal((await request(app, env, "/edgesonic/protected", "sso-token")).status, 401);

  env.SSO_MODE = "optional";
  assert.equal((await request(app, env, "/edgesonic/protected", "local-token")).status, 200);
  const optionalSso = await request(app, env, "/edgesonic/protected", "sso-token");
  assert.equal(optionalSso.status, 200);
  assert.equal((await optionalSso.json() as { source?: string }).source, "sso");
  assert.equal((await request(app, env, "/rest/ping?apiKey=alice-key")).status, 200);

  env.SSO_MODE = "required";
  assert.equal((await request(app, env, "/edgesonic/protected", "sso-token")).status, 200);
  assert.equal((await request(app, env, "/edgesonic/protected", "local-token")).status, 401);
  assert.equal((await request(app, env, "/rest/ping?apiKey=alice-key")).status, 403);

  for (const path of [
    "/edgesonic/auth/login",
    "/edgesonic/auth/register",
    "/edgesonic/auth/guest",
    "/edgesonic/auth/demo-login",
    "/edgesonic/auth/passwordReset/request",
    "/edgesonic/auth/passwordReset/confirm",
  ]) {
    const response = await app.fetch(new Request(`https://music.example${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }), env);
    assert.equal(response.status, 403, `${path} must reject local authentication in required mode`);
  }

  const loginConfig = await app.fetch(new Request("https://music.example/edgesonic/auth/loginConfig"), env);
  assert.equal(loginConfig.status, 200);
  const configBody = await loginConfig.json() as Record<string, unknown>;
  assert.equal(configBody.ssoMode, "required");
  assert.equal(configBody.ssoAvailable, true);
  assert.equal(configBody.registrationEnabled, false);
  assert.equal(configBody.passwordResetEnabled, false);
  assert.equal(configBody.ssoCallbackUrl, "https://music.example/edgesonic/auth/sso/callback");

  env.SSO_ISSUER = "not-an-issuer";
  const unavailableStart = await app.fetch(new Request("https://music.example/edgesonic/auth/sso/start"), env);
  assert.equal(unavailableStart.status, 303);
  assert.match(unavailableStart.headers.get("Location") || "", /sso_error=unavailable/);
  assert.match(unavailableStart.headers.get("Location") || "", /no_auto_sso=1/);

  env.SSO_CLIENT_SECRET = "";
  assert.equal((await request(app, env, "/edgesonic/protected", "sso-token")).status, 503);
  env.SSO_MODE = "not-a-mode";
  assert.equal((await request(app, env, "/edgesonic/protected", "sso-token")).status, 503);

  console.log("SSO mode enforcement checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
