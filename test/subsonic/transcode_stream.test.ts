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
// Coverage:
//  1. /rest/stream?format=wav transcodes a lossless source but does not expand
//     a lossy source into a lossless container
//  2. preBakeProfile() sandbox/external path: transcodes synchronously and
//     registers a cache/transcoded/ song_instances row (mirrors
//     work_upload.ts's browser_pool registration so /rest/stream's
//     findTranscodedInstance cache hits regardless of which engine produced
//     the file)
//  3. preBakeProfile() browser_pool path: enqueues a work_queue transcode row
//     instead of transcoding inline
//  4. preBakeProfile() is a no-op for an unknown profile id or a disabled
//     engine
//  5. POST /files/upload?profiles=... triggers preBakeProfile only for
//     profile ids that exist in the catalogue; unknown ids are dropped
//
// Run: npx tsx test/subsonic/transcode_stream.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { mediaRoutes } from "../../worker/src/endpoints/subsonic/media";
import { filesRoutes } from "../../worker/src/endpoints/storage/files";
import { preBakeProfile } from "../../worker/src/transcode/preBake";
import { __setEngineFactoryForTest } from "../../worker/src/transcode/factory";
import { BrowserPoolEngine } from "../../worker/src/transcode/browser_pool";
import type { TranscodeEngine, TranscodeInput, TranscodeJobRow, TranscodeOutput, TranscodeProfile } from "../../worker/src/transcode/engine";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// A fake sandbox/external-shaped engine: transcode() returns fixed bytes
// instead of actually invoking ffmpeg. Good enough to exercise the
// dispatch/persistence logic without a real container.
class FakeEngine implements TranscodeEngine {
  readonly name = "fake";
  async transcode(_input: TranscodeInput, profile: TranscodeProfile): Promise<TranscodeOutput> {
    const bytes = new TextEncoder().encode(`FAKE_${profile.id}_BYTES`);
    return {
      body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }),
      contentType: profile.contentType,
    };
  }
  async getStatus(_jobId: string): Promise<TranscodeJobRow | null> { return null; }
  async cancel(_jobId: string): Promise<void> {}
  async healthCheck(): Promise<boolean> { return true; }
}

function makeD1(sqlite: DatabaseSync): any {
  function prepare(query: string) {
    const stmt = sqlite.prepare(query);
    let boundArgs: any[] = [];
    return {
      bind(...args: any[]) { boundArgs = args; return this; },
      async first<T = any>(): Promise<T | null> {
        return (stmt.get(...boundArgs) ?? null) as T | null;
      },
      async all<T = any>(): Promise<{ results: T[]; success: true; meta: any }> {
        return { results: stmt.all(...boundArgs) as T[], success: true, meta: {} };
      },
      async run() {
        const info = stmt.run(...boundArgs);
        return { success: true, meta: { changes: Number(info.changes ?? 0) } };
      },
    };
  }
  return { prepare, batch: async (s: any[]) => Promise.all(s.map((x: any) => x.run())) };
}

function buildDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE song_masters (
      id TEXT PRIMARY KEY, album_id TEXT NOT NULL, artist_id TEXT NOT NULL,
      title TEXT NOT NULL, duration INTEGER,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY, master_id TEXT NOT NULL, source_id TEXT,
      storage_uri TEXT NOT NULL, suffix TEXT, content_type TEXT,
      size INTEGER, bit_rate INTEGER, duration INTEGER,
      tag_scanned INTEGER DEFAULT 0, source_type TEXT,
      parent_instance_id TEXT, transcode_profile TEXT, missing INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE albums (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT,
      cover_r2_key TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE artists (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE feature_strings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, description TEXT, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE work_queue (
      id TEXT PRIMARY KEY, task_type TEXT NOT NULL, payload TEXT NOT NULL,
      required_caps TEXT, priority INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'queued', claimed_by TEXT, claimed_at INTEGER,
      heartbeat_at INTEGER, result_json TEXT, error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
      created_at INTEGER NOT NULL DEFAULT 0, expires_at INTEGER
    );

    INSERT INTO artists (id, name) VALUES ('ar-1', 'Artist One');
    INSERT INTO albums (id, name) VALUES ('al-1', 'Album One');
    INSERT INTO song_masters (id, album_id, artist_id, title, duration)
      VALUES ('sm-1', 'al-1', 'ar-1', 'Song A', 180);
    INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix, content_type, size, bit_rate, source_type)
      VALUES ('si-1', 'sm-1', 'r2-local', 'r2://music/track.mp3', 'mp3', 'audio/mpeg', 500000, 320, 'original');
  `);
  return sqlite;
}

function makeR2() {
  const map = new Map<string, { data: Uint8Array; contentType: string }>();
  map.set("music/track.mp3", { data: new TextEncoder().encode("SOURCE_BYTES"), contentType: "audio/mpeg" });
  return {
    _map: map,
    async get(key: string) {
      const v = map.get(key);
      if (!v) return null;
      return {
        get body() { return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(v.data); c.close(); } }); },
        writeHttpMetadata(h: Headers) { h.set("Content-Type", v.contentType); },
        size: v.data.length,
        httpMetadata: { contentType: v.contentType },
      };
    },
    async put(key: string, data: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      map.set(key, { data: bytes, contentType: opts?.httpMetadata?.contentType || "application/octet-stream" });
    },
    async delete() {},
    async list() { return { objects: [], truncated: false }; },
  };
}

function makeCtx() {
  const tasks: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil(p: Promise<unknown>) { tasks.push(p.catch((e) => console.error("[waitUntil]", e))); } },
    flush: () => Promise.all(tasks),
  };
}

async function main() {
  console.log("1. /rest/stream?format=wav — real-time transcode via sandbox engine");
  {
    const sqlite = buildDb();
    sqlite.prepare("UPDATE song_instances SET suffix = 'flac', content_type = 'audio/flac', bit_rate = 0 WHERE id = 'si-1'").run();
    __setEngineFactoryForTest(async () => ({ engine: new FakeEngine(), kind: "sandbox" }));
    const app = new Hono<{ Bindings: any; Variables: any }>();
    app.use("*", async (c, next) => {
      c.set("user", { username: "alice", level: 2, enabled: 1, password: "x" });
      c.set("authMethod", "subsonic_cred");
      return next();
    });
    app.route("/rest", mediaRoutes);
    const env: any = { DB: makeD1(sqlite), MUSIC_BUCKET: makeR2(), INSTANCE_ID: "test-instance" };
    const r = await app.fetch(new Request("http://test/rest/stream?id=sm-1&format=wav"), env);
    assert(r.status === 200, `200 (got ${r.status})`);
    assert(r.headers.get("X-EdgeSonic-Transcoded") === "1", "marked as transcoded");
    assert(r.headers.get("X-EdgeSonic-Engine") === "sandbox", "engine header = sandbox");
    assert(r.headers.get("X-EdgeSonic-Profile") === "wav-lossless", `profile header (got ${r.headers.get("X-EdgeSonic-Profile")})`);
    assert(r.headers.get("Content-Type") === "audio/wav", `content-type audio/wav (got ${r.headers.get("Content-Type")})`);
    const body = await r.text();
    assert(body === "FAKE_wav-lossless_BYTES", "body is the fake-engine output");
    __setEngineFactoryForTest(null);
  }

  console.log("\n1b. /rest/stream?format=wav — lossy source is not expanded to lossless");
  {
    const sqlite = buildDb();
    __setEngineFactoryForTest(async () => ({ engine: new FakeEngine(), kind: "sandbox" }));
    const app = new Hono<{ Bindings: any; Variables: any }>();
    app.use("*", async (c, next) => {
      c.set("user", { username: "alice", level: 2, enabled: 1, password: "x" });
      c.set("authMethod", "subsonic_cred");
      return next();
    });
    app.route("/rest", mediaRoutes);
    const env: any = { DB: makeD1(sqlite), MUSIC_BUCKET: makeR2(), INSTANCE_ID: "test-instance" };
    const r = await app.fetch(new Request("http://test/rest/stream?id=sm-1&format=wav"), env);
    assert(r.status === 200, `raw fallback is playable (got ${r.status})`);
    assert(r.headers.get("X-EdgeSonic-Transcoded") === null, "lossy source was not transcoded to WAV");
    assert(await r.text() === "SOURCE_BYTES", "original lossy bytes are returned");
    __setEngineFactoryForTest(null);
  }

  console.log("\n2. preBakeProfile — sandbox/external path persists a transcoded song_instances row");
  {
    const sqlite = buildDb();
    const bucket: any = makeR2();
    const env: any = { DB: makeD1(sqlite), MUSIC_BUCKET: bucket, INSTANCE_ID: "test-instance" };
    __setEngineFactoryForTest(async () => ({ engine: new FakeEngine(), kind: "sandbox" }));
    await preBakeProfile(env, "http://test", "si-1", "mp3-128k");
    __setEngineFactoryForTest(null);

    const r2Key = "cache/transcoded/si-1_mp3-128k.mp3";
    assert(bucket._map.has(r2Key), `R2 object written at ${r2Key}`);
    const row = sqlite.prepare(
      "SELECT * FROM song_instances WHERE parent_instance_id = 'si-1' AND transcode_profile = 'mp3-128k'",
    ).get() as any;
    assert(!!row, "song_instances row registered");
    assert(row?.source_type === "transcoded", "source_type = transcoded");
    assert(row?.storage_uri === `r2://${r2Key}`, `storage_uri points at the R2 key (got ${row?.storage_uri})`);
  }

  console.log("\n3. preBakeProfile — browser_pool path enqueues instead of transcoding inline");
  {
    const sqlite = buildDb();
    const bucket: any = makeR2();
    const env: any = { DB: makeD1(sqlite), MUSIC_BUCKET: bucket, INSTANCE_ID: "test-instance" };
    __setEngineFactoryForTest(async () => ({ engine: new BrowserPoolEngine(env.DB, env.MUSIC_BUCKET, env), kind: "browser_pool" }));
    await preBakeProfile(env, "http://test", "si-1", "flac-lossless");
    __setEngineFactoryForTest(null);

    const rows = sqlite.prepare("SELECT * FROM work_queue WHERE task_type = 'transcode'").all() as any[];
    assert(rows.length === 1, `exactly one transcode work_queue row (got ${rows.length})`);
    const payload = JSON.parse(rows[0]?.payload ?? "{}");
    assert(payload.profileId === "flac-lossless", `payload.profileId = flac-lossless (got ${payload.profileId})`);
    assert(payload.instanceId === "si-1", "payload.instanceId = si-1");
    // browser_pool never transcodes synchronously — no R2 write, no registered
    // song_instances row at enqueue time (that happens later via /work/upload).
    assert(!bucket._map.has("cache/transcoded/si-1_flac-lossless.flac"), "no R2 write at enqueue time");
  }

  console.log("\n4. preBakeProfile — no-op for unknown profile id / disabled engine");
  {
    const sqlite = buildDb();
    const bucket: any = makeR2();
    const env: any = { DB: makeD1(sqlite), MUSIC_BUCKET: bucket, INSTANCE_ID: "test-instance" };

    __setEngineFactoryForTest(async () => ({ engine: new FakeEngine(), kind: "sandbox" }));
    await preBakeProfile(env, "http://test", "si-1", "not-a-real-profile");
    let rows = sqlite.prepare("SELECT * FROM song_instances WHERE source_type = 'transcoded'").all() as any[];
    assert(rows.length === 0, "unknown profile id produces no rows");

    __setEngineFactoryForTest(async () => null); // disabled
    await preBakeProfile(env, "http://test", "si-1", "mp3-128k");
    rows = sqlite.prepare("SELECT * FROM song_instances WHERE source_type = 'transcoded'").all() as any[];
    assert(rows.length === 0, "disabled engine produces no rows");
    __setEngineFactoryForTest(null);
  }

  console.log("\n5. POST /files/upload?profiles=... pre-bakes only known profile ids");
  {
    const sqlite = buildDb();
    const bucket: any = makeR2();
    const app = new Hono<{ Bindings: any; Variables: any }>();
    app.use("*", async (c, next) => {
      // level 3 short-circuits hasPermission — no user_permissions table needed.
      c.set("user", { username: "alice", level: 3, enabled: 1, password: "x" });
      return next();
    });
    app.route("/storage", filesRoutes);
    const db = makeD1(sqlite);
    const env: any = { DB: db, MUSIC_BUCKET: bucket, INSTANCE_ID: "test-instance" };
    __setEngineFactoryForTest(async () => ({ engine: new BrowserPoolEngine(db, bucket, env), kind: "browser_pool" }));

    const { ctx, flush } = makeCtx();
    const bytes = new TextEncoder().encode("UPLOADED_BYTES");
    const req = new Request(
      "http://test/storage/files/upload?name=new-track.flac&source=r2&profiles=mp3-128k,not-a-real-id",
      { method: "POST", headers: { "Content-Type": "audio/flac", "Content-Length": String(bytes.length) }, body: bytes },
    );
    const r = await (app.fetch as any)(req, env, ctx);
    const respBody = await r.json() as any;
    assert(r.status === 200, `upload 200 (got ${r.status}, ${JSON.stringify(respBody)})`);
    await flush();

    const rows = sqlite.prepare("SELECT * FROM work_queue WHERE task_type = 'transcode'").all() as any[];
    assert(rows.length === 1, `exactly one transcode row from the valid profile id (got ${rows.length})`);
    const payload = rows[0] ? JSON.parse(rows[0].payload) : {};
    assert(payload.profileId === "mp3-128k", `enqueued profile is mp3-128k (got ${payload.profileId})`);
    assert(payload.instanceId === respBody.id, "enqueued instanceId matches the upload response id");
    __setEngineFactoryForTest(null);
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  } else {
    console.log("\nALL PASS");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
