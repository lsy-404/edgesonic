// SPDX-License-Identifier: AGPL-3.0-or-later
// Real Hono route contract tests for R2 tag and LRC writes.
// Run: npx tsx test/internal/tag_write_r2.test.ts
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { tagEditRoutes } from "../../worker/src/endpoints/tag/write";

let failures = 0;
function assert(value: unknown, message: string) {
  if (value) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

function d1(sqlite: DatabaseSync): any {
  function prepare(sql: string) {
    const statement = sqlite.prepare(sql);
    let args: any[] = [];
    return {
      bind(...values: any[]) { args = values.map((v) => typeof v === "boolean" ? (v ? 1 : 0) : v); return this; },
      async first<T = any>() { return (statement.get(...args) ?? null) as T | null; },
      async all<T = any>() { return { results: statement.all(...args) as T[], success: true, meta: {} }; },
      async run() { const result = statement.run(...args); return { success: true, meta: { changes: Number(result.changes ?? 0) } }; },
    };
  }
  return { prepare, batch: async (items: any[]) => Promise.all(items.map((item) => item.run())) };
}

function buildDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (username TEXT PRIMARY KEY, master_password TEXT, level INTEGER, enabled INTEGER DEFAULT 1, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE user_permissions (level INTEGER, permission TEXT, enabled INTEGER, max_rph INTEGER, PRIMARY KEY(level, permission));
    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, image_r2_key TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, year INTEGER, genre TEXT, cover_r2_key TEXT, song_count INTEGER DEFAULT 0, duration INTEGER DEFAULT 0, size INTEGER DEFAULT 0, compilation INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE song_masters (id TEXT PRIMARY KEY, album_id TEXT NOT NULL, artist_id TEXT NOT NULL, album_artist_id TEXT, title TEXT NOT NULL, sort_title TEXT, track INTEGER, disc INTEGER, duration INTEGER, genre TEXT, compilation INTEGER DEFAULT 0, participants TEXT, lyrics TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE song_artists (song_id TEXT, artist_id TEXT, position INTEGER DEFAULT 0, PRIMARY KEY(song_id, artist_id));
    CREATE TABLE song_instances (id TEXT PRIMARY KEY, master_id TEXT, storage_uri TEXT, suffix TEXT, content_type TEXT, size INTEGER DEFAULT 0, bit_rate INTEGER DEFAULT 0, duration INTEGER, missing INTEGER DEFAULT 0, tag_scanned INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE storage_sources (id TEXT PRIMARY KEY, base_url TEXT, username TEXT, password TEXT, root_path TEXT, enabled INTEGER DEFAULT 1);
    INSERT INTO users VALUES ('alice','x',2,1,0,0);
    INSERT INTO user_permissions VALUES (2,'edit_tags',1,0);
    INSERT INTO artists(id,name) VALUES ('ar-old','Old Artist');
    INSERT INTO albums(id,name,sort_name) VALUES ('al-old','Old Album','old album');
    INSERT INTO song_masters(id,album_id,artist_id,title,sort_title,lyrics) VALUES ('sg-1','al-old','ar-old','Song One','song one','[00:01.00]Hello UTF-8 世界');
    INSERT INTO song_instances(id,master_id,storage_uri,suffix,content_type,size) VALUES ('inst-1','sg-1','r2://music/song.mp3','mp3','audio/mpeg',4);
  `);
  return db;
}

function bucket(options: { failPut?: boolean } = {}) {
  const objects = new Map<string, Uint8Array>([["music/song.mp3", new Uint8Array([0x41, 0x55, 0x44, 0x49])]]);
  return {
    async get(key: string) {
      const value = objects.get(key);
      return value ? { arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) } : null;
    },
    async head(key: string) { const value = objects.get(key); return value ? { size: value.length, httpMetadata: { contentType: "audio/mpeg" } } : null; },
    async put(key: string, value: Uint8Array, _opts?: unknown) {
      if (options.failPut) throw new Error("R2 put failed");
      objects.set(key, new Uint8Array(value));
    },
    objects,
  };
}

function appFor(sqlite: DatabaseSync, MUSIC_BUCKET: any) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => { c.set("user", { username: "alice", level: 2, enabled: 1, password: "x" }); c.set("authMethod", "session"); return next(); });
  app.route("/tag", tagEditRoutes);
  return async (body: unknown) => app.fetch(new Request("http://test/tag/write", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { DB: d1(sqlite), MUSIC_BUCKET });
}

async function main() {
  console.log("{write} writes library lyrics to R2 without D1 relink:");
  {
    const sqlite = buildDb();
    const b = bucket();
    const response = await appFor(sqlite, b)({ id: "sg-1", tags: { lyrics: "{write}" } });
    const body = await response.json() as any;
    const row = sqlite.prepare("SELECT album_id, artist_id, lyrics FROM song_masters WHERE id='sg-1'").get() as any;
    assert(response.status === 200 && body.ok === true, "route succeeds");
    assert(row.album_id === "al-old" && row.artist_id === "ar-old", "keyword-only write does not relink D1");
    assert(body.files?.length === 1 && body.files[0].written === true, "write returns per-instance success");
  }

  console.log("{export} returns R2 sidecar success and failure:");
  {
    const sqlite = buildDb();
    const b = bucket();
    const response = await appFor(sqlite, b)({ id: "sg-1", tags: { lyrics: "{export}" } });
    const body = await response.json() as any;
    const sidecar = b.objects.get("music/song.lrc");
    assert(response.status === 200 && body.files?.[0].written === true, "export reports written=true");
    assert(sidecar && new TextDecoder().decode(sidecar).includes("世界"), "export stores UTF-8 LRC bytes at same-name sidecar");
  }
  {
    const sqlite = buildDb();
    const response = await appFor(sqlite, bucket({ failPut: true }))({ id: "sg-1", tags: { lyrics: "{export}" } });
    const body = await response.json() as any;
    assert(response.status === 200 && body.files?.[0].written === false, "R2 failure returns a file result instead of false success");
    assert(/R2 put failed/.test(body.files[0].reason), "R2 failure reason is surfaced");
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
