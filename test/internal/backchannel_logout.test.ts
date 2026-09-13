// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signBytes, type KeyObject } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { CustomFetch } from "openid-client";
import { authMiddleware } from "../../worker/src/auth";
import { webLoginRoutes } from "../../worker/src/endpoints/edgesonic/auth";

declare global { type D1Database = unknown; type Env = unknown; }

const ISSUER = "https://identity.example";
const CLIENT_ID = "edgesonic-client";
const KID = "logout-key";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: otherPrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function logoutToken(
  overrides: Record<string, unknown> = {},
  key: KeyObject = privateKey,
  headerOverrides: Record<string, unknown> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: ISSUER,
    aud: CLIENT_ID,
    iat: now,
    exp: now + 300,
    jti: "logout-event-1",
    sub: "subject-alice",
    events: { "http://schemas.openid.net/event/backchannel-logout": {} },
    ...overrides,
  };
  const input = `${b64({ alg: "RS256", kid: KID, typ: "logout+jwt", ...headerOverrides })}.${b64(payload)}`;
  return `${input}.${signBytes("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
}

function database(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE users (username TEXT PRIMARY KEY, master_password TEXT NOT NULL, level INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
      auth_source TEXT NOT NULL DEFAULT 'local', user_agent TEXT, expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0, sso_refresh_token TEXT, sso_id_token TEXT,
      sso_token_expires_at INTEGER, sso_refresh_expires_at INTEGER, sso_issuer TEXT, sso_client_id TEXT,
      sso_dpop_key TEXT
    );
    CREATE TABLE oidc_identities (issuer TEXT NOT NULL, subject TEXT NOT NULL, username TEXT NOT NULL, created_at INTEGER NOT NULL, last_login_at INTEGER NOT NULL, PRIMARY KEY (issuer, subject));
    CREATE TABLE subsonic_credentials (id TEXT PRIMARY KEY, username TEXT NOT NULL, password TEXT NOT NULL);
    CREATE TABLE api_keys (api_key TEXT PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE guest_tokens (token TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    INSERT INTO users (username, master_password, level) VALUES ('alice', 'x', 1);
    INSERT INTO oidc_identities (issuer, subject, username, created_at, last_login_at) VALUES ('${ISSUER}', 'subject-alice', 'alice', 0, 0);
    INSERT INTO sessions (id, username, token, auth_source, sso_issuer, sso_client_id, expires_at) VALUES
      ('sso-match', 'alice', 'sso-match-token', 'sso', '${ISSUER}', '${CLIENT_ID}', unixepoch() + 3600),
      ('sso-other-client', 'alice', 'sso-other-client-token', 'sso', '${ISSUER}', 'other-client', unixepoch() + 3600),
      ('sso-other-issuer', 'alice', 'sso-other-issuer-token', 'sso', 'https://other.example', '${CLIENT_ID}', unixepoch() + 3600),
      ('local', 'alice', 'local-token', 'local', NULL, NULL, unixepoch() + 3600);
    INSERT INTO subsonic_credentials (id, username, password) VALUES ('subsonic', 'alice', 'plain-dedicated');
    INSERT INTO api_keys (api_key, username) VALUES ('api-key', 'alice');
    INSERT INTO guest_tokens (token, expires_at) VALUES ('guest-token', unixepoch() + 3600);
  `);
  return sqlite;
}

function d1(sqlite: DatabaseSync) {
  return {
    prepare(query: string) {
      const statement = sqlite.prepare(query);
      let values: unknown[] = [];
      return {
        bind(...next: unknown[]) { values = next; return this; },
        async first<T>(): Promise<T | null> { return (statement.get(...values) ?? null) as T | null; },
        async run() { const result = statement.run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
      };
    },
  };
}

function fetcher(): CustomFetch {
  return async (input) => {
    const url = String(input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` }), { status: 200 });
    }
    if (url === `${ISSUER}/jwks`) {
      const jwk = publicKey.export({ format: "jwk" });
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }), { status: 200 });
    }
    throw new Error(`unexpected request ${url}`);
  };
}

function makeApp(sqlite: DatabaseSync) {
  const app = new Hono();
  app.route("/", webLoginRoutes);
  app.use("/edgesonic/*", authMiddleware);
  const env = { DB: d1(sqlite), SSO_MODE: "optional", SSO_ISSUER: ISSUER, SSO_CLIENT_ID: CLIENT_ID, SSO_CLIENT_SECRET: "secret" } as never;
  return { app, env };
}

async function post(app: Hono, env: never, body: string, contentType = "application/x-www-form-urlencoded") {
  return app.fetch(new Request("https://music.example/edgesonic/auth/sso/backchannel-logout", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  }), env);
}

async function main() {
  const sqlite = database();
  const { app, env } = makeApp(sqlite);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher() as typeof fetch;
  try {
    const valid = encodeURIComponent(logoutToken());
    const first = await post(app, env, `logout_token=${valid}`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("Cache-Control"), "no-store");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sessions WHERE id = 'sso-match'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 3);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM subsonic_credentials").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM guest_tokens").get().count, 1);

    const second = await post(app, env, `logout_token=${valid}&provider_hint=ignored`);
    assert.equal(second.status, 200);

    for (const token of [
      logoutToken({ aud: "other-client" }),
      logoutToken({}, privateKey, { typ: "JWT" }),
      logoutToken({ iss: "https://wrong.example" }),
      logoutToken({}, otherPrivateKey),
      logoutToken({ nonce: "must-not-be-present" }),
      logoutToken({ events: {} }),
      logoutToken({ events: { "http://schemas.openid.net/event/backchannel-logout": null } }),
      logoutToken({ exp: undefined }),
      logoutToken({ iat: Math.floor(Date.now() / 1000) - 301 }),
    ]) {
      const response = await post(app, env, `logout_token=${encodeURIComponent(token)}`);
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { ok: boolean; error: string }).error, "invalid_logout_token");
    }
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 3);
    assert.equal((await post(app, env, "logout_token=x", "application/json")).status, 400);
    assert.equal((await post(app, env, "logout_token=x&logout_token=y&provider_hint=ignored")).status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().then(() => console.log("backchannel logout tests passed"));
