// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signBytes, type KeyObject } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { CustomFetch } from "openid-client";
import {
  beginOidcAuthorization,
  clearOidcTransactionCookie,
  completeOidcAuthorization,
  OIDC_TRANSACTION_COOKIE,
  OidcFlowError,
  validateAuthorizationResponseState,
} from "../../worker/src/utils/oidc";

declare global { type D1Database = unknown; type Env = unknown; }

const ISSUER = "https://identity.example";
const CLIENT_ID = "edgesonic-client";
const CLIENT_SECRET = "unit-test-client-secret";
const APP_ORIGIN = "https://music.example";
const CALLBACK = `${APP_ORIGIN}/edgesonic/auth/sso/callback`;

function makeD1(sqlite: DatabaseSync): any {
  function prepare(query: string) {
    const statement = sqlite.prepare(query);
    let values: any[] = [];
    return {
      bind(...next: any[]) { values = next; return this; },
      async first<T = any>(): Promise<T | null> { return (statement.get(...values) ?? null) as T | null; },
      async all<T = any>(): Promise<{ results: T[]; success: true; meta: object }> {
        return { results: statement.all(...values) as T[], success: true, meta: {} };
      },
      async run() {
        const result = statement.run(...values);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
  }
  return {
    prepare,
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function buildDatabase(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      username TEXT PRIMARY KEY,
      master_password TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      nickname TEXT,
      email TEXT,
      activation_status TEXT NOT NULL DEFAULT 'permanent',
      activated_until INTEGER,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      auth_source TEXT NOT NULL DEFAULT 'local' CHECK (auth_source IN ('local', 'sso')),
      user_agent TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
    );
    CREATE TABLE oidc_identities (
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      username TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_login_at INTEGER NOT NULL,
      PRIMARY KEY (issuer, subject),
      FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
    );
    CREATE TABLE subsonic_credentials (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      expires_at INTEGER
    );
    CREATE TABLE song_masters (id TEXT PRIMARY KEY, cover_r2_key TEXT);
    CREATE TABLE features (key TEXT PRIMARY KEY, value INTEGER NOT NULL, description TEXT);
    CREATE TABLE feature_strings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      description TEXT,
      updated_at INTEGER
    );
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL,
      permission TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      max_rph INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    INSERT INTO features (key, value) VALUES ('enable_activation', 0);
    INSERT INTO users
      (username, master_password, level, enabled, email, activation_status, created_at, updated_at)
      VALUES ('existing-admin', 'x', 3, 1, 'same@example.com', 'permanent', unixepoch(), unixepoch());
    INSERT INTO oidc_identities (issuer, subject, username, created_at, last_login_at)
      VALUES ('https://identity.example', 'person-123', 'existing-admin', unixepoch(), unixepoch());
  `);
  return sqlite;
}

function environment(sqlite: DatabaseSync) {
  return {
    DB: makeD1(sqlite),
    INSTANCE_ID: "test-instance",
    SSO_MODE: "optional",
    SSO_ISSUER: ISSUER,
    SSO_CLIENT_ID: CLIENT_ID,
    SSO_CLIENT_SECRET: CLIENT_SECRET,
    SSO_PROVIDER_NAME: "Identity",
  } as any;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function formEncode(value: string): string {
  return encodeURIComponent(value).replace(/[-_.!~*'()]|%20/g, (part) => part === "%20" ? "+" : `%${part.charCodeAt(0).toString(16).toUpperCase()}`);
}

function signIdToken(payload: Record<string, unknown>, privateKey: KeyObject): string {
  const protectedHeader = encodeJson({ alg: "RS256", kid: "provider-key", typ: "JWT" });
  const encodedPayload = encodeJson(payload);
  const input = `${protectedHeader}.${encodedPayload}`;
  const signature = signBytes("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  return `${input}.${signature}`;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type ClaimOverrides = Partial<Record<"iss" | "aud" | "exp" | "nonce" | "sub", unknown>>;

function provider(options: { claims?: ClaimOverrides; signingKey?: KeyObject } = {}) {
  const trusted = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signingKey = options.signingKey || trusted.privateKey;
  const publicJwk = trusted.publicKey.export({ format: "jwk" });
  const calls: string[] = [];
  let expectedNonce = "";
  let expectedChallenge = "";
  let receivedVerifier = "";

  const providerFetch: CustomFetch = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    calls.push(url.pathname);
    if (url.pathname === "/.well-known/openid-configuration") {
      return jsonResponse({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        userinfo_endpoint: `${ISSUER}/oauth/userinfo`,
        jwks_uri: `${ISSUER}/oauth/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/oauth/token") {
      const headers = new Headers(init.headers);
      assert.equal(
        headers.get("Authorization"),
        `Basic ${Buffer.from(`${formEncode(CLIENT_ID)}:${formEncode(CLIENT_SECRET)}`).toString("base64")}`,
      );
      const body = new URLSearchParams(String(init.body || ""));
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("code"), "provider-code");
      assert.equal(body.get("redirect_uri"), CALLBACK);
      receivedVerifier = body.get("code_verifier") || "";
      const challengeBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(receivedVerifier));
      assert.equal(Buffer.from(challengeBytes).toString("base64url"), expectedChallenge);
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: ISSUER,
        aud: CLIENT_ID,
        sub: "person-123",
        iat: now,
        exp: now + 300,
        nonce: expectedNonce,
        roles: ["administrator"],
        level: 3,
        ...options.claims,
      };
      return jsonResponse({
        access_token: "provider-access-token",
        token_type: "Bearer",
        expires_in: 300,
        id_token: signIdToken(claims, signingKey),
      });
    }
    if (url.pathname === "/oauth/jwks") {
      return jsonResponse({
        keys: [{ ...publicJwk, kid: "provider-key", use: "sig", alg: "RS256" }],
      });
    }
    if (url.pathname === "/oauth/userinfo") {
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer provider-access-token");
      return jsonResponse({
        sub: "person-123",
        preferred_username: "remote-person",
        email: "same@example.com",
        roles: ["administrator"],
      });
    }
    return jsonResponse({ error: "not_found" }, 404);
  };

  return {
    fetch: providerFetch,
    calls,
    setAuthorizationRequest(url: URL) {
      expectedNonce = url.searchParams.get("nonce") || "";
      expectedChallenge = url.searchParams.get("code_challenge") || "";
    },
    get receivedVerifier() { return receivedVerifier; },
  };
}

function cookiePair(setCookie: string): string {
  return setCookie.split(";", 1)[0];
}

async function begin(currentProvider: ReturnType<typeof provider>, env: ReturnType<typeof environment>) {
  const started = await beginOidcAuthorization(env, `${APP_ORIGIN}/login`, currentProvider.fetch);
  const authorizationUrl = new URL(started.authorizationUrl);
  currentProvider.setAuthorizationRequest(authorizationUrl);
  return { started, authorizationUrl, cookie: cookiePair(started.transactionCookie) };
}

async function complete(
  currentProvider: ReturnType<typeof provider>,
  env: ReturnType<typeof environment>,
  state: string,
  cookie: string,
  callback = CALLBACK,
) {
  return completeOidcAuthorization(
    env,
    `${callback}?code=provider-code&state=${encodeURIComponent(state)}`,
    cookie,
    "OIDC integration test",
    currentProvider.fetch,
  );
}

async function expectFailure(run: () => Promise<unknown>, label: string) {
  await assert.rejects(run, undefined, label);
}

async function main() {
  assert.doesNotThrow(() => validateAuthorizationResponseState(`${CALLBACK}?response=signed-jarm`, "expected-state"));
  assert.doesNotThrow(() => validateAuthorizationResponseState(`${CALLBACK}?state=expected-state`, "expected-state"));
  assert.throws(
    () => validateAuthorizationResponseState(`${CALLBACK}?state=wrong-state`, "expected-state"),
    (error: unknown) => error instanceof OidcFlowError && error.code === "state_mismatch",
  );
  const sqlite = buildDatabase();
  const env = environment(sqlite);
  const currentProvider = provider();
  const { started, authorizationUrl, cookie } = await begin(currentProvider, env);

  assert.equal(authorizationUrl.origin, "https://identity.example");
  assert.equal(authorizationUrl.pathname, "/oauth/authorize");
  assert.equal(authorizationUrl.searchParams.get("response_type"), "code");
  assert.equal(authorizationUrl.searchParams.get("scope"), "openid profile email offline_access");
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), CALLBACK);
  assert.ok(authorizationUrl.searchParams.get("state"));
  assert.ok(authorizationUrl.searchParams.get("nonce"));
  assert.match(started.transactionCookie, new RegExp(`^${OIDC_TRANSACTION_COOKIE}=`));
  assert.match(started.transactionCookie, /HttpOnly/);
  assert.match(started.transactionCookie, /SameSite=Lax/);
  assert.match(started.transactionCookie, /Secure/);
  assert.doesNotMatch(started.transactionCookie, new RegExp(authorizationUrl.searchParams.get("state") as string));
  assert.doesNotMatch(started.transactionCookie, new RegExp(authorizationUrl.searchParams.get("nonce") as string));

  const result = await complete(
    currentProvider,
    env,
    authorizationUrl.searchParams.get("state") as string,
    cookie,
  );
  assert.equal(result.level, 3, "the mapped local user keeps its existing level");
  assert.equal(result.username, "existing-admin", "OIDC login must use the explicit identity mapping");
  assert.ok(currentProvider.receivedVerifier.length >= 43);
  assert.ok(currentProvider.calls.includes("/oauth/token"));
  assert.ok(currentProvider.calls.includes("/oauth/jwks"));
  assert.ok(currentProvider.calls.includes("/oauth/userinfo"));

  const mapped = sqlite.prepare(
    "SELECT username FROM oidc_identities WHERE issuer = ? AND subject = ?",
  ).get(ISSUER, "person-123") as { username: string };
  assert.equal(mapped.username, result.username);
  assert.equal((sqlite.prepare("SELECT level FROM users WHERE username = 'existing-admin'").get() as { level: number }).level, 3);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE username LIKE 'sso_%'").get() as { count: number }).count, 0);
  assert.equal((sqlite.prepare("SELECT auth_source FROM sessions WHERE token = ?").get(result.sessionToken) as { auth_source: string }).auth_source, "sso");

  const second = await begin(currentProvider, env);
  const repeated = await complete(currentProvider, env, second.authorizationUrl.searchParams.get("state") as string, second.cookie);
  assert.equal(repeated.username, result.username);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count, 1);

  const stateProvider = provider();
  const stateStart = await begin(stateProvider, env);
  await assert.rejects(
    () => complete(stateProvider, env, "wrong-state", stateStart.cookie),
    (error: unknown) => error instanceof OidcFlowError && error.code === "state_mismatch",
  );

  const tamperedProvider = provider();
  const tamperedStart = await begin(tamperedProvider, env);
  const last = tamperedStart.cookie.at(-1) as string;
  const tamperedCookie = `${tamperedStart.cookie.slice(0, -1)}${last === "A" ? "B" : "A"}`;
  await assert.rejects(
    () => complete(tamperedProvider, env, tamperedStart.authorizationUrl.searchParams.get("state") as string, tamperedCookie),
    (error: unknown) => error instanceof OidcFlowError && error.code === "invalid_transaction",
  );

  const originProvider = provider();
  const originStart = await begin(originProvider, env);
  await assert.rejects(
    () => complete(
      originProvider,
      env,
      originStart.authorizationUrl.searchParams.get("state") as string,
      originStart.cookie,
      "https://other.example/edgesonic/auth/sso/callback",
    ),
    (error: unknown) => error instanceof OidcFlowError && error.code === "transaction_context_mismatch",
  );

  for (const [label, claims] of [
    ["nonce", { nonce: "wrong-nonce" }],
    ["issuer", { iss: "https://other-issuer.example/" }],
    ["audience", { aud: "other-client" }],
    ["expiry", { exp: Math.floor(Date.now() / 1000) - 60 }],
  ] as const) {
    const failingProvider = provider({ claims });
    const failingStart = await begin(failingProvider, env);
    await expectFailure(
      () => complete(failingProvider, env, failingStart.authorizationUrl.searchParams.get("state") as string, failingStart.cookie),
      `${label} validation must fail`,
    );
  }

  const rogue = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signatureProvider = provider({ signingKey: rogue.privateKey });
  const signatureStart = await begin(signatureProvider, env);
  await expectFailure(
    () => complete(signatureProvider, env, signatureStart.authorizationUrl.searchParams.get("state") as string, signatureStart.cookie),
    "an ID Token signed outside the discovered RS256 JWKS must fail",
  );

  sqlite.prepare("DELETE FROM oidc_identities WHERE issuer = ? AND subject = ?").run(ISSUER, "person-123");
  const unmappedProvider = provider();
  const unmappedStart = await begin(unmappedProvider, env);
  await assert.rejects(
    () => complete(unmappedProvider, env, unmappedStart.authorizationUrl.searchParams.get("state") as string, unmappedStart.cookie),
    (error: unknown) => error instanceof OidcFlowError && error.code === "identity_not_mapped",
    "an unmapped OIDC identity must be rejected without creating a synthetic user",
  );
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE username LIKE 'sso_%'").get() as { count: number }).count, 0);

  assert.match(clearOidcTransactionCookie(`${APP_ORIGIN}/callback`), /Max-Age=0/);
  console.log("OIDC authorization, verification, mapping, and transaction-cookie checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
