import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { submitUploadMetadata } from "../../worker/src/mcp/uploads";
import type { McpPrincipal } from "../../worker/src/mcp/context";

function makeD1(sqlite: DatabaseSync): any {
  function prepare(query: string) {
    const stmt = sqlite.prepare(query);
    let boundArgs: any[] = [];
    return {
      bind(...args: any[]) { boundArgs = args; return this; },
      async first<T = any>(): Promise<T | null> {
        const row = stmt.get(...boundArgs);
        return (row ?? null) as T | null;
      },
      async all<T = any>(): Promise<{ results: T[]; success: true; meta: any }> {
        const rows = stmt.all(...boundArgs) as T[];
        return { results: rows, success: true, meta: {} };
      },
      async run(): Promise<{ success: true; meta: { changes: number } }> {
        const info = stmt.run(...boundArgs);
        return { success: true, meta: { changes: Number(info.changes ?? 0) } };
      },
    };
  }
  return { prepare, batch: async (stmts: any[]) => Promise.all(stmts.map((s) => s.run())) };
}

// ---------------------------------------------------------------------------
// Schema — subset that metadata.ts + permissionMiddleware touch.
// ---------------------------------------------------------------------------
function buildDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE users (
      username TEXT PRIMARY KEY,
      master_password TEXT NOT NULL,
      level INTEGER DEFAULT 1,
      enabled INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE work_queue (id TEXT PRIMARY KEY, task_type TEXT, payload TEXT, status TEXT, created_at INTEGER, required_caps TEXT, priority INTEGER, claimed_by TEXT, claimed_at INTEGER, heartbeat_at INTEGER, result_json TEXT, error_message TEXT, attempts INTEGER, max_attempts INTEGER);
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL,
      permission TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      max_rph INTEGER DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    CREATE TABLE artists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_name TEXT,
      image_r2_key TEXT,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE albums (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_name TEXT,
      year INTEGER,
      genre TEXT,
      cover_r2_key TEXT,
      song_count INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 0,
      size INTEGER DEFAULT 0,
      compilation INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE song_masters (
      id TEXT PRIMARY KEY,
      album_id TEXT NOT NULL,
      artist_id TEXT NOT NULL,
      album_artist_id TEXT,
      title TEXT NOT NULL,
      sort_title TEXT,
      track INTEGER,
      disc INTEGER,
      duration INTEGER,
      genre TEXT,
      compilation INTEGER DEFAULT 0,
      participants TEXT,
      lyrics TEXT,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    -- Relinking a song rewrites its display artists through this join table.
    CREATE TABLE song_artists (
      song_id TEXT NOT NULL,
      artist_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (song_id, artist_id)
    );
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY,
      master_id TEXT NOT NULL,
      source_id TEXT,
      storage_uri TEXT NOT NULL,
      suffix TEXT,
      content_type TEXT,
      size INTEGER DEFAULT 0,
      bit_rate INTEGER DEFAULT 0,
      sample_rate INTEGER,
      bit_depth INTEGER,
      channels INTEGER,
      duration INTEGER,
      missing INTEGER DEFAULT 0,
      tag_scanned INTEGER DEFAULT 0,
      source_type TEXT DEFAULT 'original',
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE storage_entries (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      parent_id TEXT,
      path TEXT,
      kind TEXT,
      instance_id TEXT
    );

    -- Seed: one admin with edit_tags + manage_sources (the latter for /findInstanceByUri).
    INSERT INTO users (username, master_password, level) VALUES ('alice', 'x', 2);
    INSERT INTO user_permissions VALUES (2, 'edit_tags', 1, 0);
    INSERT INTO user_permissions VALUES (2, 'manage_sources', 1, 0);

    INSERT INTO artists (id, name) VALUES ('ar-old', 'Old Artist');
    INSERT INTO albums (id, name) VALUES ('al-old', 'Old Album');

    INSERT INTO song_masters (id, album_id, artist_id, title, track, duration)
      VALUES ('sg-1', 'al-old', 'ar-old', 'Song One', 1, 0);

    INSERT INTO song_instances (id, master_id, storage_uri, suffix, content_type, size, tag_scanned)
      VALUES ('inst-1', 'sg-1', 'r2://music/foo.m4a', 'm4a', 'audio/mp4', 5000000, 0);
  `);
  return sqlite;
}


test("ticket metadata is owner-bound, generation-bound, and applied once without a secret", async () => {
  const sqlite = buildDb();
  sqlite.exec("CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)");
  const env = { DB: makeD1(sqlite) } as Env;
  const principal = { user: { username: "owner", enabled: 1, level: 1 }, scopes: ["mcp:upload"] } as McpPrincipal;
  const generation = { instanceId: "inst-1", storageUri: "r2://music/foo.m4a", uploadNonce: "original" };
  const ticket = { owner: "owner", expiresAt: Math.floor(Date.now() / 1000) + 1000, state: "completed", generation };
  sqlite.prepare("INSERT INTO kv_store VALUES (?, ?, 0)").run("mcp:upload:first", JSON.stringify(ticket));
  sqlite.prepare("INSERT INTO kv_store VALUES (?, ?, 0)").run("mcp:upload:second", JSON.stringify({ ...ticket, generation: { ...generation, uploadNonce: "other" } }));
  sqlite.prepare("INSERT INTO work_queue (id, task_type, payload, status) VALUES (?, ?, ?, ?)").run("wm-upload-pending-inst-1", "manual_upload_pending", JSON.stringify(generation), "canceled");
  await assert.rejects(submitUploadMetadata(env, { ...principal, user: { ...principal.user, username: "other" } }, "first", { title: "Wrong" }), /not found/);
  await assert.rejects(submitUploadMetadata(env, principal, "second", { title: "Wrong" }), /generation/);
  const applied = await submitUploadMetadata(env, principal, "first", { title: "New title", sampleRate: 48000, channels: 2 });
  assert.equal(applied.ok, true);
  assert.equal(sqlite.prepare("SELECT title FROM song_masters WHERE id='sg-1'").get()?.title, "New title");
  assert.equal(sqlite.prepare("SELECT sample_rate FROM song_instances WHERE id='inst-1'").get()?.sample_rate, 48000);
  await assert.rejects(submitUploadMetadata(env, principal, "first", { title: "Replay" }), /already applied/);
  sqlite.close();
});
