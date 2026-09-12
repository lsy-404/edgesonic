import { Hono } from "hono";
import { browseRoutes } from "../../worker/src/endpoints/storage/browse";
import { filesRoutes } from "../../worker/src/endpoints/storage/files";
import { mediaRoutes } from "../../worker/src/endpoints/subsonic/media";

declare global { type D1Database = unknown; type Env = unknown; }

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

interface Entry {
  id: string; path: string; display_name: string; kind: "folder" | "file";
  parent_id: string | null; object_id: string | null; instance_id: string | null;
  physical_key: string | null; content_type: string | null; size: number | null; updated_at: number;
}

function makeBucket() {
  const store = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    store,
    async put(key: string, body: unknown, opts?: { httpMetadata?: { contentType?: string } }) {
      const bytes = body instanceof Uint8Array
        ? body
        : new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
      store.set(key, { bytes, contentType: opts?.httpMetadata?.contentType || "application/octet-stream" });
    },
    async get(key: string, opts?: { range?: { offset: number; length?: number } }) {
      const item = store.get(key);
      if (!item) return null;
      const start = opts?.range?.offset || 0;
      const end = opts?.range?.length === undefined ? undefined : start + opts.range.length;
      const bytes = item.bytes.slice(start, end);
      return { body: new Blob([bytes]).stream(), size: item.bytes.length, httpMetadata: { contentType: item.contentType } };
    },
    async delete(key: string | string[]) {
      for (const item of Array.isArray(key) ? key : [key]) store.delete(item);
    },
  };
}

function makeD1(entries: Entry[], resolvedSong?: Record<string, unknown>) {
  const instances = new Map(entries.filter((e) => e.instance_id).map((e) => [e.instance_id!, { master_id: "song-1" }]));
  const db = {
    prepare(sql: string) {
      const stmt = {
        args: [] as unknown[],
        bind(...args: unknown[]) { stmt.args = args; return stmt; },
        async first<T = unknown>() {
          if (sql.includes("FROM user_permissions")) return { enabled: 1, max_rph: 0 } as T;
          if (sql.includes("FROM storage_entries e") && sql.includes("o.physical_key = ?")) {
            const row = entries.find((e) => e.physical_key === stmt.args[1]);
            return (row || null) as T | null;
          }
          if (sql.includes("FROM storage_entries e") && sql.includes("e.path = ?")) {
            const row = entries.find((e) => e.path === stmt.args[1]);
            return (row || null) as T | null;
          }
          if (sql.includes("FROM song_instances")) return (resolvedSong || null) as T | null;
          return null;
        },
        async all<T = unknown>() {
          if (sql.includes("FROM storage_entries e") && sql.includes("e.parent_id IS ?")) {
            const parentId = stmt.args[1] as string | null;
            return { results: entries.filter((e) => e.parent_id === parentId).sort((a, b) => a.display_name.localeCompare(b.display_name)) as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          if (sql.includes("UPDATE storage_entries SET parent_id")) {
            const [parentId, path, name, , id] = stmt.args as [string | null, string, string, number, string];
            const row = entries.find((e) => e.id === id);
            if (row) { row.parent_id = parentId; row.path = path; row.display_name = name; }
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  void instances;
  return db;
}

function makeApp(bucket: ReturnType<typeof makeBucket>, entries: Entry[], resolvedSong?: Record<string, unknown>) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "root", level: 3, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/storage", browseRoutes);
  app.route("/storage", filesRoutes);
  app.route("/rest", mediaRoutes);
  const env = { DB: makeD1(entries, resolvedSong), MUSIC_BUCKET: bucket };
  return { get: (url: string, headers?: HeadersInit) => app.fetch(new Request(`http://test${url}`, { headers }), env), post: (url: string, body: unknown) => app.fetch(new Request(`http://test${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), env) };
}

async function main() {
  const bucket = makeBucket();
  bucket.store.set("objects/obj_audio.mp3", { bytes: new Uint8Array([10, 11, 12, 13]), contentType: "audio/mpeg" });
  bucket.store.set("objects/obj_note.lrc", { bytes: new Uint8Array([91, 49, 93]), contentType: "text/plain" });
  const entries: Entry[] = [
    { id: "folder-1", path: "music/Album", display_name: "Album", kind: "folder", parent_id: "music-root", object_id: null, instance_id: null, physical_key: null, content_type: null, size: null, updated_at: 1787661296 },
    { id: "audio-1", path: "music/Album/track.mp3", display_name: "track.mp3", kind: "file", parent_id: "folder-1", object_id: "obj-audio", instance_id: "si-1", physical_key: "objects/obj_audio.mp3", content_type: "audio/mpeg", size: 4, updated_at: 1787661296 },
    { id: "lrc-1", path: "music/Album/track.lrc", display_name: "track.lrc", kind: "file", parent_id: "folder-1", object_id: "obj-note", instance_id: null, physical_key: "objects/obj_note.lrc", content_type: "text/plain", size: 3, updated_at: 1787661296 },
  ];
  const root = { id: "music-root", path: "music", display_name: "music", kind: "folder" as const, parent_id: null, object_id: null, instance_id: null, physical_key: null, content_type: null, size: null, updated_at: 1787661296 };
  entries.push(root);
  const app = makeApp(bucket, entries, { id: "song-1", title: "track", artist: "Artist", album: "Album", coverArt: "cover-1", duration: 245 });

  console.log("\nfiles/list r2 → D1 supplies logical folders and display names:");
  {
    const r = await app.get("/storage/files/list?source=r2&path=music/Album");
    const j = await r.json<{ ok: boolean; files: { name: string; uri: string }[] }>();
    assert(r.status === 200 && j.ok, "listing returns ok=true");
    assert(j.files.map((f) => f.name).join(",") === "track.lrc,track.mp3", "listing uses D1 display names");
    assert(j.files.some((f) => f.uri === "r2://objects/obj_audio.mp3"), "listing returns immutable physical URI");
  }

  console.log("\nstreamFile r2 → resolves logical path to the stable object key:");
  {
    const full = await app.get("/rest/streamFile?source=r2&path=music/Album/track.mp3");
    assert(full.status === 200, "full stream returns 200");
    assert((await full.arrayBuffer()).byteLength === 4, "full stream reads the stable object");
    const ranged = await app.get("/rest/streamFile?source=r2&path=music/Album/track.mp3", { Range: "bytes=1-2" });
    assert(ranged.status === 206 && ranged.headers.get("Content-Range") === "bytes 1-2/4", "logical stream keeps range support");
  }

  console.log("\nfiles/move → changes only the D1 logical entry:");
  {
    const before = bucket.store.size;
    const r = await app.post("/storage/files/move", { key: "objects/obj_audio.mp3", dest: "music/Album/renamed.mp3" });
    const j = await r.json<{ ok: boolean }>();
    assert(r.status === 200 && j.ok, "logical rename succeeds");
    assert(bucket.store.size === before && bucket.store.has("objects/obj_audio.mp3"), "R2 bytes are not copied or deleted");
    assert(entries.find((e) => e.id === "audio-1")?.path === "music/Album/renamed.mp3", "D1 path is updated");
  }

  console.log("\nfiles/resolve → matches a stable URI to its catalog song:");
  {
    const r = await app.get(`/storage/files/resolve?uri=${encodeURIComponent("r2://objects/obj_audio.mp3")}`);
    const j = await r.json<{ ok: boolean; song?: { id: string } }>();
    assert(r.status === 200 && j.ok && j.song?.id === "song-1", "stable URI resolves to the catalog song");
    assert((await app.get("/rest/streamFile?source=r2&path=music/../outside.flac")).status === 400, "path traversal is rejected");
  }

  console.log(`\n${failures === 0 ? "All tests passed." : `${failures} test(s) FAILED.`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
