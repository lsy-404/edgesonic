import { Hono } from "hono";
import { filesRoutes } from "../../worker/src/endpoints/storage/files";

declare global { type D1Database = unknown; type Env = unknown; }

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

interface Entry {
  id: string; path: string; display_name: string; kind: "folder" | "file";
  parent_id: string | null; object_id: string | null; instance_id: string | null;
  physical_key: string | null;
}
interface Instance { id: string; master_id: string }
interface Master { id: string; album_id: string; artist_id: string }

function makeBucket() {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    async get(key: string) {
      const bytes = store.get(key);
      if (!bytes) return null;
      return { body: new Blob([bytes]).stream(), size: bytes.length, httpMetadata: { contentType: "audio/mpeg" }, customMetadata: {} };
    },
    async put(key: string, body: unknown) {
      store.set(key, body instanceof Uint8Array ? body : new Uint8Array(await new Response(body as BodyInit).arrayBuffer()));
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
    },
  };
}

function makeD1(entries: Entry[], instances: Instance[], masters: Master[]) {
  const db = {
    prepare(sql: string) {
      const normalized = sql.trim().replace(/\s+/g, " ");
      const stmt = {
        args: [] as unknown[],
        bind(...args: unknown[]) { stmt.args = args; return stmt; },
        async first<T = unknown>() {
          if (normalized.includes("FROM user_permissions")) return { enabled: 1, max_rph: 0 } as T;
          if (normalized.includes("FROM storage_entries WHERE source_id") && normalized.includes("kind = 'folder'") && normalized.includes("path = ?")) {
            return (entries.find((e) => e.path === stmt.args[1] && e.kind === "folder") || null) as T | null;
          }
          if (normalized.includes("FROM storage_entries e") && normalized.includes("o.physical_key = ?")) {
            return (entries.find((e) => e.physical_key === stmt.args[1]) || null) as T | null;
          }
          if (normalized.includes("FROM storage_entries e") && normalized.includes("e.path = ?")) {
            return (entries.find((e) => e.path === stmt.args[1]) || null) as T | null;
          }
          if (normalized.includes("SELECT COUNT(*) AS n FROM song_instances WHERE master_id = ?")) {
            return { n: instances.filter((i) => i.master_id === stmt.args[0]).length } as T;
          }
          if (normalized.includes("SELECT album_id, artist_id FROM song_masters WHERE id = ?")) {
            return (masters.find((m) => m.id === stmt.args[0]) || null) as T | null;
          }
          if (normalized.includes("SELECT master_id FROM song_instances WHERE id = ?")) {
            const item = instances.find((i) => i.id === stmt.args[0]);
            return (item ? { master_id: item.master_id } : null) as T | null;
          }
          return null;
        },
        async all<T = unknown>() {
          if (normalized.includes("FROM storage_entries e") && normalized.includes("e.parent_id IS ?")) {
            return { results: entries.filter((e) => e.parent_id === stmt.args[1]) as T[] };
          }
          if (normalized.includes("FROM storage_entries") && normalized.includes("path LIKE ?")) {
            const prefix = String(stmt.args[2]).replace(/%$/, "");
            return { results: entries.filter((e) => e.id === stmt.args[1] || e.path === stmt.args[1] || e.path.startsWith(prefix)) as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          if (normalized.includes("INSERT INTO storage_sources")) return { meta: { changes: 1 } };
          if (normalized.includes("INSERT INTO storage_entries") && normalized.includes("'folder'")) {
            const [id, , parentId, path, name] = stmt.args as [string, string, string | null, string, string];
            if (!entries.some((e) => e.path === path)) entries.push({ id, path, display_name: name, kind: "folder", parent_id: parentId, object_id: null, instance_id: null, physical_key: null });
            return { meta: { changes: 1 } };
          }
          if (normalized.includes("UPDATE storage_entries SET parent_id")) {
            const [parentId, path, name, , id] = stmt.args as [string | null, string, string, number, string];
            const row = entries.find((e) => e.id === id);
            if (row) { row.parent_id = parentId; row.path = path; row.display_name = name; }
            return { meta: { changes: 1 } };
          }
          if (normalized.includes("DELETE FROM song_instances WHERE id = ?")) {
            const index = instances.findIndex((i) => i.id === stmt.args[0]);
            if (index >= 0) instances.splice(index, 1);
          } else if (normalized.includes("DELETE FROM storage_entries WHERE id = ?")) {
            const id = stmt.args[0];
            const descendants = new Set(entries.filter((e) => e.id === id || e.parent_id === id).map((e) => e.id));
            for (const entry of entries.filter((e) => descendants.has(e.id))) {
              const index = entries.indexOf(entry);
              if (index >= 0) entries.splice(index, 1);
            }
          } else if (normalized.includes("DELETE FROM storage_objects WHERE id = ?")) {
            // The object table is represented by the entry fixture only.
          } else if (normalized.includes("DELETE FROM song_masters WHERE id = ?")) {
            const index = masters.findIndex((m) => m.id === stmt.args[0]);
            if (index >= 0) masters.splice(index, 1);
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return db;
}

function makeApp(bucket: ReturnType<typeof makeBucket>, entries: Entry[], instances: Instance[] = [], masters: Master[] = []) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "root", level: 3, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/storage", filesRoutes);
  const env = { DB: makeD1(entries, instances, masters), MUSIC_BUCKET: bucket };
  return { post: (url: string, body: unknown) => app.fetch(new Request(`http://test${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), env) };
}

async function main() {
  console.log("\nmoveFolder → updates D1 paths without copying R2 objects:");
  {
    const bucket = makeBucket();
    bucket.store.set("objects/a.mp3", new Uint8Array([1]));
    bucket.store.set("objects/b.flac", new Uint8Array([2]));
    const entries: Entry[] = [
      { id: "root", path: "music/a", display_name: "a", kind: "folder", parent_id: null, object_id: null, instance_id: null, physical_key: null },
      { id: "sub", path: "music/a/sub", display_name: "sub", kind: "folder", parent_id: "root", object_id: null, instance_id: null, physical_key: null },
      { id: "e1", path: "music/a/t1.mp3", display_name: "t1.mp3", kind: "file", parent_id: "root", object_id: "o1", instance_id: "i1", physical_key: "objects/a.mp3" },
      { id: "e2", path: "music/a/sub/t2.flac", display_name: "t2.flac", kind: "file", parent_id: "sub", object_id: "o2", instance_id: "i2", physical_key: "objects/b.flac" },
    ];
    const app = makeApp(bucket, entries, [{ id: "i1", master_id: "m1" }, { id: "i2", master_id: "m2" }]);
    const r = await app.post("/storage/files/moveFolder", { path: "music/a", dest: "music/b/a" });
    const j = await r.json<{ ok: boolean; moved: number }>();
    assert(r.status === 200 && j.ok && j.moved === 4, "folder move succeeds and reports D1 entries");
    assert(bucket.store.has("objects/a.mp3") && bucket.store.has("objects/b.flac"), "R2 objects stay at immutable keys");
    assert(entries.some((e) => e.path === "music/b/a/t1.mp3") && entries.some((e) => e.path === "music/b/a/sub/t2.flac"), "nested logical paths are re-homed");
  }

  console.log("\nmoveFolder → rejects self and descendants:");
  {
    const entries: Entry[] = [{ id: "root", path: "music/a", display_name: "a", kind: "folder", parent_id: null, object_id: null, instance_id: null, physical_key: null }];
    const app = makeApp(makeBucket(), entries);
    assert((await app.post("/storage/files/moveFolder", { path: "music/a", dest: "music/a" })).status === 400, "self destination is rejected");
    assert((await app.post("/storage/files/moveFolder", { path: "music/a", dest: "music/a/inner" })).status === 400, "descendant destination is rejected");
  }

  console.log("\ndeleteFolder → deletes the logical subtree and its R2 objects:");
  {
    const bucket = makeBucket();
    bucket.store.set("objects/a.mp3", new Uint8Array([1]));
    bucket.store.set("objects/keep.mp3", new Uint8Array([2]));
    const entries: Entry[] = [
      { id: "kill", path: "music/kill", display_name: "kill", kind: "folder", parent_id: null, object_id: null, instance_id: null, physical_key: null },
      { id: "e1", path: "music/kill/a.mp3", display_name: "a.mp3", kind: "file", parent_id: "kill", object_id: "o1", instance_id: "i1", physical_key: "objects/a.mp3" },
      { id: "keep", path: "music/keep.mp3", display_name: "keep.mp3", kind: "file", parent_id: null, object_id: "o2", instance_id: "i2", physical_key: "objects/keep.mp3" },
    ];
    const instances = [{ id: "i1", master_id: "m1" }, { id: "i2", master_id: "m2" }];
    const masters = [{ id: "m1", album_id: "al1", artist_id: "ar1" }, { id: "m2", album_id: "al2", artist_id: "ar2" }];
    const app = makeApp(bucket, entries, instances, masters);
    const r = await app.post("/storage/files/deleteFolder", { path: "music/kill" });
    const j = await r.json<{ ok: boolean; deleted: number }>();
    assert(r.status === 200 && j.ok && j.deleted === 2, "folder delete removes folder and file entries");
    assert(!bucket.store.has("objects/a.mp3") && bucket.store.has("objects/keep.mp3"), "only the logical subtree object is deleted");
    assert(!entries.some((e) => e.path.startsWith("music/kill")) && instances.length === 1 && masters.length === 1, "D1 catalog cleanup preserves the sibling");
  }

  console.log(`\n${failures === 0 ? "All tests passed." : `${failures} test(s) FAILED.`}`);
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
