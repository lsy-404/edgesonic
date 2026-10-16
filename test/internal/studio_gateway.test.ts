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

// Studio gateway: subject → user mapping, the relay allowlist, and relayed
// requests running through the real auth/permission/route stack as the
// mapped user. The WorkerEntrypoint wrapper (studio/gateway.ts) needs the
// workerd runtime, so these tests drive studio/operations.ts directly with a
// Hono app wired like index.ts.
//
// Run: pnpm exec tsx --test test/internal/studio_gateway.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { authMiddleware } from "../../worker/src/auth";
import { formatMiddleware } from "../../worker/src/middleware/format";
import { apiRateLimitMiddleware } from "../../worker/src/middleware/rate_limit";
import { pingRoutes } from "../../worker/src/endpoints/subsonic/ping";
import { searchRoutes } from "../../worker/src/endpoints/subsonic/searching";
import { mediaRoutes } from "../../worker/src/endpoints/subsonic/media";
import { filesRoutes } from "../../worker/src/endpoints/storage/files";
import { resetR2PresignHealthForTesting } from "../../worker/src/utils/r2presign";
import { relayStudioRequest, studioPermissions } from "../../worker/src/studio/operations";
import { isStudioRelayRoute, studioRelayContext, withStudioRelay } from "../../worker/src/studio/relay";
import { installFixedLengthStream } from "../helpers/fixedLengthStream";

installFixedLengthStream();

declare global { type D1Database = unknown; type Env = unknown; }

const ISSUER = "https://id.example";
const AUDIO = new TextEncoder().encode("FLAC_AUDIO_BYTES");

// R2 credential-health probes are the only outbound fetches; keep them local.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes(".r2.cloudflarestorage.com")) return new Response(null, { status: 200 });
  return realFetch(input, init);
}) as typeof fetch;
resetR2PresignHealthForTesting();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeD1(sqlite: DatabaseSync): any {
  function prepare(query: string) {
    const statement = sqlite.prepare(query);
    let values: unknown[] = [];
    return {
      bind(...next: unknown[]) { values = next; return this; },
      async first<T>(): Promise<T | null> { return (statement.get(...(values as never[])) ?? null) as T | null; },
      async all<T>(): Promise<{ results: T[]; success: true; meta: object }> {
        return { results: statement.all(...(values as never[])) as T[], success: true, meta: {} };
      },
      async run() {
        const result = statement.run(...(values as never[]));
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
  }
  return {
    prepare,
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

function makeBucket() {
  const objects = new Map<string, { data: Uint8Array; contentType: string }>([
    ["music/album/track.flac", { data: AUDIO, contentType: "audio/flac" }],
  ]);
  function object(key: string, data: Uint8Array, size: number, contentType: string) {
    return {
      key,
      size,
      httpEtag: `"${key}"`,
      httpMetadata: { contentType },
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); controller.close(); } }),
      writeHttpMetadata(headers: Headers) { headers.set("Content-Type", contentType); },
    };
  }
  return {
    objects,
    async head(key: string) {
      const value = objects.get(key);
      return value ? { key, size: value.data.byteLength } : null;
    },
    async get(key: string, options?: { range?: { offset: number; length?: number } }) {
      const value = objects.get(key);
      if (!value) return null;
      const { offset = 0, length } = options?.range ?? {};
      const end = length === undefined ? value.data.byteLength : offset + length;
      return object(key, value.data.slice(offset, end), value.data.byteLength, value.contentType);
    },
    async put(key: string, body: ReadableStream<Uint8Array> | Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
      const data = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { data, contentType: options?.httpMetadata?.contentType || "application/octet-stream" });
      return { key, size: data.byteLength };
    },
    async delete(key: string) { objects.delete(key); },
    async list() { return { objects: [...objects].map(([key, value]) => ({ key, size: value.data.byteLength })), truncated: false }; },
  };
}

function buildDatabase(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE users (
      username TEXT PRIMARY KEY, master_password TEXT NOT NULL, level INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, nickname TEXT, email TEXT,
      activation_status TEXT NOT NULL DEFAULT 'permanent', activated_until INTEGER,
      created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE identity_accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE);
    CREATE TABLE oidc_identities (
      issuer TEXT NOT NULL, subject TEXT NOT NULL, username TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), last_login_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (issuer, subject)
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
      auth_source TEXT NOT NULL DEFAULT 'local' CHECK (auth_source IN ('local', 'sso')),
      user_agent TEXT, sso_refresh_token TEXT, sso_id_token TEXT, sso_token_expires_at INTEGER,
      sso_refresh_expires_at INTEGER, sso_issuer TEXT, sso_client_id TEXT, sso_dpop_key TEXT,
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT 0
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
    CREATE TABLE features (key TEXT PRIMARY KEY, value INTEGER NOT NULL, description TEXT, updated_at INTEGER);
    CREATE TABLE feature_strings (key TEXT PRIMARY KEY, value TEXT NOT NULL, description TEXT, updated_at INTEGER);
    CREATE TABLE artists (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, image_r2_key TEXT,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE albums (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, year INTEGER, genre TEXT, cover_r2_key TEXT,
      song_count INTEGER DEFAULT 0, duration INTEGER DEFAULT 0, size INTEGER DEFAULT 0,
      compilation INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE song_masters (
      id TEXT PRIMARY KEY, album_id TEXT NOT NULL, artist_id TEXT NOT NULL, album_artist_id TEXT,
      title TEXT NOT NULL, sort_title TEXT, track INTEGER, disc INTEGER, duration INTEGER, genre TEXT,
      compilation INTEGER DEFAULT 0, participants TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY, master_id TEXT NOT NULL, source_id TEXT, storage_uri TEXT NOT NULL,
      storage_object_id TEXT, suffix TEXT, content_type TEXT, size INTEGER, bit_rate INTEGER, duration INTEGER,
      tag_scanned INTEGER DEFAULT 0, source_etag TEXT, source_last_modified TEXT, parent_instance_id TEXT,
      transcode_profile TEXT, source_type TEXT, missing INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE annotations (
      user_id TEXT NOT NULL, item_id TEXT NOT NULL, item_type TEXT NOT NULL,
      play_count INTEGER DEFAULT 0, play_date INTEGER, rating INTEGER, starred INTEGER DEFAULT 0, starred_at INTEGER,
      PRIMARY KEY (user_id, item_id, item_type)
    );
    CREATE TABLE storage_sources (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT, base_url TEXT, root_path TEXT, region TEXT,
      mode TEXT, enabled INTEGER DEFAULT 1, username TEXT, password TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE storage_objects (
      id TEXT PRIMARY KEY, physical_key TEXT NOT NULL UNIQUE, legacy_key TEXT UNIQUE, suffix TEXT NOT NULL,
      content_type TEXT, size INTEGER NOT NULL DEFAULT 0, etag TEXT, last_modified INTEGER,
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE storage_entries (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, parent_id TEXT, path TEXT NOT NULL,
      display_name TEXT NOT NULL, kind TEXT NOT NULL, object_id TEXT, instance_id TEXT, companion_of TEXT,
      created_at INTEGER, updated_at INTEGER, UNIQUE (source_id, path)
    );

    INSERT INTO users (username, master_password, level, enabled, activation_status) VALUES
      ('alice', 'x', 1, 1, 'permanent'),
      ('editor', 'x', 2, 1, 'permanent'),
      ('bob', 'x', 1, 1, 'permanent'),
      ('frozen', 'x', 1, 1, 'disabled'),
      ('off', 'x', 1, 0, 'permanent'),
      ('guest', 'x', 0, 1, 'permanent');
    INSERT INTO oidc_identities (issuer, subject, username) VALUES
      ('${ISSUER}', 'sub-alice', 'alice'),
      ('${ISSUER}', 'sub-frozen', 'frozen'),
      ('${ISSUER}', 'sub-off', 'off'),
      ('${ISSUER}', 'sub-guest', 'guest'),
      ('https://other-issuer.example', 'sub-bob', 'bob');
    INSERT INTO identity_accounts (id, username) VALUES ('sub-editor', 'editor');
    INSERT INTO sessions (id, username, token, auth_source, expires_at)
      VALUES ('bob-session', 'bob', 'bob-cookie', 'sso', unixepoch() + 3600);
    INSERT INTO subsonic_credentials (id, username, password, stream_proxy_strategy)
      VALUES ('bob-client', 'bob', 'bob-client-password', 'always');
    INSERT INTO user_permissions (level, permission, enabled) VALUES
      (1, 'stream', 1), (1, 'browse', 1), (1, 'search', 1), (1, 'upload', 0), (1, 'manage_users', 1),
      (2, 'stream', 1), (2, 'browse', 1), (2, 'search', 1), (2, 'upload', 0), (2, 'edit_tags', 1);
    INSERT INTO features (key, value) VALUES ('enable_activation', 1);
    INSERT INTO feature_strings (key, value) VALUES ('enable_r2_presign', '1');

    INSERT INTO artists (id, name, sort_name) VALUES ('ar-1', 'Artist One', 'artist one');
    INSERT INTO albums (id, name) VALUES ('al-1', 'Album One');
    INSERT INTO song_masters (id, album_id, artist_id, title, duration) VALUES ('sm-1', 'al-1', 'ar-1', 'Song A', 180);
    INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix, content_type, size, bit_rate, source_type)
      VALUES ('si-r2', 'sm-1', 'r2-local', 'r2://music/album/track.flac', 'flac', 'audio/flac', ${AUDIO.byteLength}, 1411, 'original');
    INSERT INTO annotations (user_id, item_id, item_type, starred, starred_at) VALUES ('alice', 'ar-1', 'artist', 1, 1700000000);
  `);
  return sqlite;
}

const sqlite = buildDatabase();
const rateLimitKeys: string[] = [];
const env = {
  DB: makeD1(sqlite),
  MUSIC_BUCKET: makeBucket(),
  INSTANCE_ID: "test-instance",
  SSO_MODE: "optional",
  SSO_ISSUER: `${ISSUER}/`,
  SSO_CLIENT_ID: "edgesonic-client",
  SSO_CLIENT_SECRET: "client-secret",
  SSO_SHARED_IDENTITY_MAPPING: "1",
  CANONICAL_HOST: "music.example",
  R2_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  R2_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  CF_ACCOUNT_ID: "df4481f3ce1fa0394b4617442a97d147",
  API_RATE_LIMITER: {
    async limit({ key }: { key: string }) { rateLimitKeys.push(key); return { success: true }; },
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as any;

// Wired like index.ts for the buckets the relay can touch, plus stand-ins for
// routes outside the allowlist that answer 200 when reached.
const app = new Hono();
app.use("/rest/*", formatMiddleware);
for (const prefix of ["/rest/*", "/storage/*", "/edgesonic/*"]) app.use(prefix, authMiddleware);
for (const prefix of ["/rest/*", "/storage/*", "/edgesonic/*"]) app.use(prefix, apiRateLimitMiddleware);
app.get("/rest/getUsers", (c) => c.json({ reached: true }));
app.get("/edgesonic/auth/me", (c) => c.json({ reached: true }));
app.post("/storage/files/delete", (c) => c.json({ reached: true }));
app.route("/rest", pingRoutes);
app.route("/rest", searchRoutes);
app.route("/rest", mediaRoutes);
app.route("/storage", filesRoutes);

const dispatched: Request[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function dispatch(request: Request, relayEnv: any, executionCtx: any): Promise<Response> {
  dispatched.push(request);
  return app.fetch(request, relayEnv, executionCtx);
}

function relay(subject: string, url: string, init?: RequestInit) {
  return relayStudioRequest(env, ctx, subject, new Request(url, init), dispatch);
}

function setPermission(level: number, permission: string, enabled: boolean) {
  sqlite.prepare("UPDATE user_permissions SET enabled = ? WHERE level = ? AND permission = ?").run(enabled ? 1 : 0, level, permission);
}

test("allowlist accepts the listed operations and their .view aliases only", () => {
  for (const op of ["ping", "search3", "getAlbumList2", "getAlbum", "getSong", "getCoverArt", "stream", "getLyricsBySongId"]) {
    assert.equal(isStudioRelayRoute("GET", `/rest/${op}`), true, op);
    assert.equal(isStudioRelayRoute("GET", `/rest/${op}.view`), true, `${op}.view`);
    assert.equal(isStudioRelayRoute("POST", `/rest/${op}`), false, `POST ${op}`);
  }
  assert.equal(isStudioRelayRoute("POST", "/storage/files/upload"), true);
  assert.equal(isStudioRelayRoute("GET", "/storage/files/upload"), false);
  assert.equal(isStudioRelayRoute("GET", "/rest/ping/"), false);
  assert.equal(isStudioRelayRoute("GET", "/rest/getUsers"), false);
});

test("mapped subject gets the effective permission map", async () => {
  const alice = await studioPermissions(env, "sub-alice");
  assert.ok(alice);
  assert.equal(alice.username, "alice");
  assert.equal(alice.level, 1);
  assert.equal(alice.permissions.stream, true);
  assert.equal(alice.permissions.upload, false);
  assert.equal(alice.permissions.manage_users, false, "hardlocked level-1 permission stays off");

  const editor = await studioPermissions(env, "sub-editor");
  assert.equal(editor?.username, "editor", "shared identity_accounts mapping resolves");
  assert.equal(editor?.level, 2);
  const linked = sqlite.prepare("SELECT username FROM oidc_identities WHERE issuer = ? AND subject = ?").get(ISSUER, "sub-editor") as { username: string } | undefined;
  assert.equal(linked?.username, "editor", "shared mapping is persisted under the configured issuer");
});

test("unmapped, disabled, inactive, guest and foreign-issuer subjects resolve to null", async () => {
  for (const subject of ["sub-nobody", "sub-off", "sub-frozen", "sub-guest", "sub-bob", ""]) {
    assert.equal(await studioPermissions(env, subject), null, subject || "(empty)");
  }
  env.SSO_MODE = "disabled";
  try {
    assert.equal(await studioPermissions(env, "sub-alice"), null, "no relay identity while SSO is disabled");
  } finally {
    env.SSO_MODE = "optional";
  }
});

test("unavailable identity -> 401 before dispatch", async () => {
  dispatched.length = 0;
  for (const subject of ["sub-nobody", "sub-frozen", "sub-off"]) {
    const response = await relay(subject, "https://edgesonic/rest/ping?f=json");
    assert.equal(response.status, 401, subject);
    assert.deepEqual(await response.json(), { ok: false, error: "identity_unavailable" });
  }
  assert.equal(dispatched.length, 0);
});

test("non-allowlisted operations -> 403 before dispatch", async () => {
  dispatched.length = 0;
  const cases: Array<[string, string]> = [
    ["GET", "https://edgesonic/rest/getUsers?f=json"],
    ["GET", "https://edgesonic/edgesonic/auth/me"],
    ["POST", "https://edgesonic/storage/files/delete"],
    ["GET", "https://edgesonic/storage/files/upload?name=a.lrc"],
    ["POST", "https://edgesonic/rest/search3?query=a"],
    ["GET", "https://edgesonic/rest/ping/"],
    ["GET", "https://edgesonic/rest/%73earch3"],
  ];
  for (const [method, url] of cases) {
    const response = await relay("sub-alice", url, { method });
    assert.equal(response.status, 403, `${method} ${url}`);
    assert.deepEqual(await response.json(), { ok: false, error: "operation_not_allowed" });
  }
  assert.equal(dispatched.length, 0);
});

test("auth middleware refuses relay context outside the allowlist", async () => {
  const alice = sqlite.prepare("SELECT * FROM users WHERE username = 'alice'").get();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const relayEnv = withStudioRelay(env, { subject: "sub-alice", user: { ...(alice as any), password: "x" } });
  const users = await app.fetch(new Request("https://music.example/rest/getUsers?f=json"), relayEnv, ctx);
  assert.equal(users.status, 403);
  assert.equal(((await users.json()) as { reached?: boolean }).reached, undefined);
  const me = await app.fetch(new Request("https://music.example/edgesonic/auth/me"), relayEnv, ctx);
  assert.equal(me.status, 403);
  assert.deepEqual(await me.json(), { ok: false, error: "Operation not allowed for relay" });
});

test("search3 runs as the mapped user and ignores supplied credentials", async () => {
  dispatched.length = 0;
  rateLimitKeys.length = 0;
  const response = await relay(
    "sub-alice",
    "https://caller.invalid/rest/search3?query=Artist&albumCount=0&songCount=0&f=json&u=bob&p=bob-client-password&t=x&s=y&apiKey=k&esChain=test-instance",
    {
      headers: {
        Cookie: "edgesonic_session=bob-cookie",
        Authorization: "Bearer someone-else",
        "X-EdgeSonic-Chain": "test-instance",
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Set-Cookie"), null);
  const body = await response.json() as { "subsonic-response": { status: string; searchResult3: { artist: Array<{ id: string; starred?: string }> } } };
  assert.equal(body["subsonic-response"].status, "ok");
  const [artist] = body["subsonic-response"].searchResult3.artist;
  assert.equal(artist.id, "ar-1");
  assert.ok(artist.starred, "alice's own annotation is applied, so the request ran as alice");

  const seen = dispatched[0];
  const seenUrl = new URL(seen.url);
  assert.equal(seenUrl.origin, "https://music.example", "caller host is replaced by the canonical host");
  for (const key of ["u", "p", "t", "s", "apiKey", "esChain"]) assert.equal(seenUrl.searchParams.has(key), false, key);
  assert.equal(seenUrl.searchParams.get("query"), "Artist");
  for (const name of ["Cookie", "Authorization", "X-EdgeSonic-Chain"]) assert.equal(seen.headers.get(name), null, name);
  assert.ok(rateLimitKeys.some((key) => key.startsWith("api:alice:")), "rate limit keyed by the relay user");
});

test("upload: EdgeSonic's own level and permission checks decide", async () => {
  const upload = (subject: string, query: string) => relay(subject, `https://edgesonic/storage/files/upload?${query}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "Content-Length": "8" },
    body: "[00:01]a",
  });
  const level1 = await upload("sub-alice", "name=song.lrc&source=r2&path=LRC%2FAlbum%20One");
  assert.equal(level1.status, 403);
  assert.deepEqual(await level1.json(), { ok: false, error: "File operations require admin privileges (level 2+)" });

  const noUpload = await upload("sub-editor", "name=song.lrc&source=r2&path=LRC%2FAlbum%20One");
  assert.equal(noUpload.status, 403);
  assert.deepEqual(await noUpload.json(), { ok: false, error: "Not authorized" });

  setPermission(2, "upload", true);
  try {
    const ok = await upload("sub-editor", "name=song.lrc&source=r2&path=LRC%2FAlbum%20One&conflict=error");
    assert.equal(ok.status, 200);
    const body = await ok.json() as { ok: boolean; key: string; conflict: { finalKey: string; renamed: boolean } };
    assert.equal(body.ok, true);
    assert.equal(body.conflict.finalKey, "LRC/Album One/song.lrc");
    assert.equal(body.conflict.renamed, false);
    assert.equal(new TextDecoder().decode(env.MUSIC_BUCKET.objects.get(body.key)?.data), "[00:01]a");
    const entry = sqlite.prepare("SELECT kind FROM storage_entries WHERE path = ?").get("LRC/Album One/song.lrc") as { kind: string } | undefined;
    assert.equal(entry?.kind, "file");

    const conflict = await upload("sub-editor", "name=song.lrc&source=r2&path=LRC%2FAlbum%20One");
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as { error: string }).error, "File already exists");
  } finally {
    setPermission(2, "upload", false);
  }
});

test("stream never answers with a presigned redirect for relay requests", async () => {
  // Control: a Subsonic client credential on the same setup gets the 302.
  const control = await app.fetch(new Request("https://music.example/rest/stream?id=sm-1&u=bob&p=bob-client-password"), env, ctx);
  assert.equal(control.status, 302, "presign is live for ordinary clients");

  const full = await relay("sub-alice", "https://edgesonic/rest/stream?id=sm-1");
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("Location"), null);
  assert.equal(new TextDecoder().decode(await full.arrayBuffer()), "FLAC_AUDIO_BYTES");

  const ranged = await relay("sub-alice", "https://edgesonic/rest/stream.view?id=sm-1", { headers: { Range: "bytes=2-5" } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("Content-Range"), `bytes 2-5/${AUDIO.byteLength}`);
  assert.equal(new TextDecoder().decode(await ranged.arrayBuffer()), "AC_A");
});

test("relay responses drop Set-Cookie and turn redirects into 502", async () => {
  const fixed = (response: Response) => relayStudioRequest(env, ctx, "sub-alice", new Request("https://edgesonic/rest/ping"), async () => response);
  const redirected = await fixed(new Response(null, { status: 302, headers: { Location: "https://bucket.example/signed" } }));
  assert.equal(redirected.status, 502);
  assert.equal(redirected.headers.get("Location"), null);
  assert.deepEqual(await redirected.json(), { ok: false, error: "relay_redirect_blocked" });

  const notModified = await fixed(new Response(null, { status: 304, headers: { ETag: "\"x\"" } }));
  assert.equal(notModified.status, 304);

  const cookie = await fixed(new Response("ok", { status: 200, headers: { "Set-Cookie": "a=b", "X-Kept": "1" } }));
  assert.equal(cookie.headers.get("Set-Cookie"), null);
  assert.equal(cookie.headers.get("X-Kept"), "1");
});

test("public requests cannot obtain a relay identity", async () => {
  assert.equal(studioRelayContext(env), null, "relaying never mutates the shared env");
  const attempts = [
    new Request("https://music.example/rest/search3?query=Artist&f=json&subject=sub-alice"),
    new Request("https://music.example/rest/search3?query=Artist&f=json", { headers: { "X-Studio-Subject": "sub-alice", "X-Relay-User": "alice" } }),
    new Request("https://music.example/storage/files/upload?name=a.lrc", { method: "POST", body: "x", headers: { "Content-Length": "1" } }),
  ];
  for (const request of attempts) {
    const response = await app.fetch(request, env, ctx);
    assert.equal(response.status, 401, request.url);
  }
});
