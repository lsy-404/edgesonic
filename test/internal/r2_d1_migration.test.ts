import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { migrationRoutes } from "../../worker/src/endpoints/storage/migrate";
import { installFixedLengthStream } from "../helpers/fixedLengthStream";

installFixedLengthStream();

declare global { type D1Database = unknown; type Env = unknown; }

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

function makeD1(sqlite: DatabaseSync): any {
  return {
    prepare(query: string) {
      const stmt = sqlite.prepare(query);
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) { args = values; return this; },
        async first<T = unknown>() { return (stmt.get(...args) ?? null) as T | null; },
        async all<T = unknown>() { return { results: stmt.all(...args) as T[] }; },
        async run() { return { meta: { changes: Number(stmt.run(...args).changes ?? 0) } }; },
      };
    },
  };
}

function buildDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE user_permissions (level INTEGER, permission TEXT, enabled INTEGER, max_rph INTEGER, PRIMARY KEY(level, permission));
    CREATE TABLE storage_sources (id TEXT PRIMARY KEY, type TEXT, name TEXT, base_url TEXT, root_path TEXT, mode TEXT DEFAULT 'library', enabled INTEGER DEFAULT 1, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE song_instances (id TEXT PRIMARY KEY, master_id TEXT, source_id TEXT, storage_uri TEXT, storage_object_id TEXT, suffix TEXT, content_type TEXT, size INTEGER, missing INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE storage_objects (id TEXT PRIMARY KEY, physical_key TEXT NOT NULL UNIQUE, legacy_key TEXT UNIQUE, suffix TEXT NOT NULL, content_type TEXT, size INTEGER NOT NULL DEFAULT 0, etag TEXT, last_modified INTEGER, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE storage_entries (id TEXT PRIMARY KEY, source_id TEXT, parent_id TEXT, path TEXT NOT NULL, display_name TEXT NOT NULL, kind TEXT NOT NULL, object_id TEXT, instance_id TEXT, companion_of TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE UNIQUE INDEX idx_storage_entries_source_path ON storage_entries(source_id, path);
    INSERT INTO user_permissions VALUES (3, 'manage_files', 1, 0);
    INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix, content_type, size) VALUES ('si-1', 'sm-1', 'r2-local', 'r2://music/Artist/Album/song.mp3', 'mp3', 'audio/mpeg', 3);
  `);
  return sqlite;
}

function makeBucket() {
  const store = new Map<string, Uint8Array>([["music/Artist/Album/song.mp3", new Uint8Array([1, 2, 3])]]);
  return {
    store,
    async list({ prefix }: { prefix?: string }) {
      const objects = [...store.entries()]
        .filter(([key]) => key.startsWith(prefix || ""))
        .map(([key, bytes]) => ({ key, size: bytes.length, etag: "etag-1", uploaded: new Date("2026-09-11T00:00:00Z"), httpMetadata: { contentType: "audio/mpeg" }, customMetadata: {} }));
      return { objects, truncated: false, cursor: undefined };
    },
    async get(key: string) {
      const bytes = store.get(key);
      if (!bytes) return null;
      return { body: new Blob([bytes]).stream(), size: bytes.length, httpMetadata: { contentType: "audio/mpeg" }, customMetadata: {} };
    },
    async head(key: string) {
      const bytes = store.get(key);
      return bytes ? { size: bytes.length, httpMetadata: { contentType: "audio/mpeg" } } : null;
    },
    async put(key: string, body: unknown) {
      store.set(key, new Uint8Array(await new Response(body as BodyInit).arrayBuffer()));
    },
    async delete(key: string) { store.delete(key); },
  };
}

async function main() {
  const sqlite = buildDb();
  const bucket = makeBucket();
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => { c.set("user", { username: "root", level: 3 }); return next(); });
  app.route("/storage", migrationRoutes);
  const env = { DB: makeD1(sqlite), MUSIC_BUCKET: bucket };

  console.log("R2+D1 migration → copies and indexes a legacy object:");
  const first = await app.fetch(new Request("http://test/storage/files/migrate-r2", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
  }), env);
  const firstBody = await first.json() as any;
  const object = sqlite.prepare("SELECT * FROM storage_objects WHERE legacy_key = 'music/Artist/Album/song.mp3'").get() as any;
  const entry = sqlite.prepare("SELECT * FROM storage_entries WHERE path = 'music/Artist/Album/song.mp3'").get() as any;
  const instance = sqlite.prepare("SELECT storage_uri, storage_object_id FROM song_instances WHERE id = 'si-1'").get() as any;
  assert(first.status === 200 && firstBody.complete === true, "bounded migration completes");
  assert(object?.physical_key === instance?.storage_uri.replace("r2://", ""), "D1 object and instance reference the same stable key");
  assert(/^objects\/obj_[0-9a-f]{16}\.mp3$/.test(object?.physical_key || ""), "stable object key retains the suffix");
  assert(entry?.instance_id === "si-1" && object?.size === 3, "logical entry and metadata are indexed");
  assert(bucket.store.has("music/Artist/Album/song.mp3") && bucket.store.has(object.physical_key), "copy phase preserves the legacy object until cleanup");

  console.log("cleanup phase → deletes only the verified legacy key:");
  const second = await app.fetch(new Request("http://test/storage/files/migrate-r2", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deleteLegacy: true }),
  }), env);
  const secondBody = await second.json() as any;
  assert(second.status === 200 && secondBody.deleted === 1, "cleanup reports one deleted legacy key");
  assert(!bucket.store.has("music/Artist/Album/song.mp3") && bucket.store.has(object.physical_key), "stable object remains after cleanup");

  console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) FAILED.`);
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
