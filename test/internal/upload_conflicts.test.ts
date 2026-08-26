// POST /storage/files/upload conflict handling and idempotent registration.
// Run: npx tsx test/internal/upload_conflicts.test.ts

import { Hono } from "hono";
import { filesRoutes } from "../../worker/src/endpoints/storage/files";

declare global {
  type D1Database = unknown;
  type D1PreparedStatement = unknown;
  type Env = unknown;
}

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

function makeBucket(entries: Array<string | [string, number]> = []) {
  const sizes = new Map(entries.map((entry) => Array.isArray(entry) ? entry : [entry, 4]));
  const objects = new Set(sizes.keys());
  const puts: string[] = [];
  return {
    objects,
    puts,
    async head(key: string) { return objects.has(key) ? { key, size: sizes.get(key) || 0 } : null; },
    async get(key: string) { return objects.has(key) ? { key } : null; },
    async put(key: string) { objects.add(key); sizes.set(key, 4); puts.push(key); },
    async delete(key: string) { objects.delete(key); sizes.delete(key); },
    async list() { return { objects: [...objects].map((key) => ({ key, size: sizes.get(key) || 0 })), truncated: false }; },
  };
}

function makeDb(existingUri?: string) {
  const calls: string[] = [];
  let masterInserts = 0;
  let instanceInserts = 0;
  let updates = 0;
  const db = {
    calls,
    get masterInserts() { return masterInserts; },
    get instanceInserts() { return instanceInserts; },
    get updates() { return updates; },
    prepare(sql: string) {
      const compact = sql.replace(/\s+/g, " ").trim();
      const statement = {
        args: [] as unknown[],
        bind(...args: unknown[]) { statement.args = args; return statement; },
        async first<T = unknown>(): Promise<T | null> {
          calls.push(compact);
          if (compact.includes("FROM song_instances WHERE storage_uri")) {
            return existingUri === statement.args[0] ? { id: "si-existing", master_id: "sm-existing" } as T : null;
          }
          if (compact.includes("FROM storage_sources")) {
            return { id: "webdav", base_url: "https://dav.test", username: "writer", password: "secret", root_path: "" } as T;
          }
          if (compact.includes("FROM user_permissions")) return { enabled: 1, max_rph: 0 } as T;
          return null;
        },
        async all<T = unknown>() { calls.push(compact); return { results: [] as T[], success: true, meta: {} }; },
        async run() {
          calls.push(compact);
          if (compact.startsWith("INSERT INTO song_masters")) masterInserts++;
          if (compact.startsWith("INSERT INTO song_instances")) instanceInserts++;
          if (compact.startsWith("UPDATE song_instances")) updates++;
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) { return Promise.all(statements.map((statement) => statement.run())); },
  };
  return db;
}

function makeUpload(bucket: ReturnType<typeof makeBucket>, db: ReturnType<typeof makeDb>, extraEnv: Record<string, unknown> = {}) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "root", level: 3, enabled: 1, password: "x" });
    return next();
  });
  app.route("/storage", filesRoutes);
  return async (source: "r2" | "webdav", conflict?: string) => {
    const query = new URLSearchParams({ name: "song.mp3", source });
    if (conflict) query.set("conflict", conflict);
    const response = await app.fetch(new Request(`http://test/storage/files/upload?${query}`, {
      method: "POST", headers: { "Content-Length": "4", "Content-Type": "audio/mpeg" }, body: new Uint8Array([1, 2, 3, 4]),
    }), { DB: db, MUSIC_BUCKET: bucket, ...extraEnv });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
}

async function checkConflicts(bucket: ReturnType<typeof makeBucket>, db: ReturnType<typeof makeDb>) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "root", level: 3, enabled: 1, password: "x" });
    return next();
  });
  app.route("/storage", filesRoutes);
  const response = await app.fetch(new Request("http://test/storage/files/upload-conflicts", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "r2", files: [{ name: "song.mp3" }, { name: "new.flac", path: "Album" }] }),
  }), { DB: db, MUSIC_BUCKET: bucket });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function main() {
  console.log("R2 conflict contract:");
  {
    const bucket = makeBucket(["music/song.mp3"]);
    const db = makeDb();
    const result = await makeUpload(bucket, db)("r2");
    assert(result.status === 409, "default policy rejects an existing R2 object");
    assert(result.body.conflict?.requestedKey === "music/song.mp3", "conflict response identifies the requested key");
    assert(result.body.conflict?.policies?.join(",") === "error,overwrite,rename", "conflict response advertises every supported policy");
    assert(bucket.puts.length === 0, "reject never overwrites the object");
  }
  {
    const bucket = makeBucket([["music/song.mp3", 10]]);
    const result = await makeUpload(bucket, makeDb("r2://music/song.mp3"), { R2_MAX_LIMIT: "12" })("r2", "overwrite");
    assert(result.status === 200, "overwrite storage projection subtracts the old object size");
  }
  {
    const result = await checkConflicts(makeBucket(["music/song.mp3"]), makeDb());
    assert(result.status === 200 && result.body.conflicts?.length === 1, "batch preflight returns only the conflicting files");
    assert(result.body.items?.[1]?.key === "music/Album/new.flac" && result.body.items?.[1]?.conflict === false, "batch preflight returns each final path");
  }
  {
    const bucket = makeBucket(["music/song.mp3"]);
    const result = await makeUpload(bucket, makeDb())("r2", "rename");
    assert(result.status === 200 && result.body.key === "music/song (1).mp3", "rename selects the first available R2 key");
    assert(result.body.conflict?.renamed === true && result.body.conflict?.finalKey === "music/song (1).mp3", "success reports the final R2 path");
  }

  console.log("overwrite reuses the registered original instance:");
  {
    const bucket = makeBucket(["music/song.mp3"]);
    const db = makeDb("r2://music/song.mp3");
    const result = await makeUpload(bucket, db)("r2", "overwrite");
    assert(result.status === 200 && result.body.id === "si-existing", "overwrite returns the existing instance id");
    assert(db.updates === 1, "overwrite refreshes the existing instance");
    assert(db.masterInserts === 0 && db.instanceInserts === 0, "overwrite creates neither a master nor an instance duplicate");
  }

  console.log("WebDAV receives the same server-side decision:");
  {
    const originalFetch = globalThis.fetch;
    const methods: Array<{ method: string; url: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method || "GET";
      const url = String(input);
      methods.push({ method, url });
      if (method === "HEAD") return new Response(null, { status: url.includes("song%20(1).mp3") ? 404 : 200 });
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    try {
      const bucket = makeBucket();
      const db = makeDb();
      const upload = makeUpload(bucket, db);
      const rejected = await upload("webdav");
      assert(rejected.status === 409, "default policy rejects an existing WebDAV object");
      assert(!methods.some((call) => call.method === "PUT"), "rejected WebDAV upload does not PUT");
      methods.length = 0;
      const renamed = await upload("webdav", "rename");
      assert(renamed.status === 200 && renamed.body.key === "music/song (1).mp3", "WebDAV rename chooses an available path");
      assert(methods.some((call) => call.method === "PUT" && call.url.endsWith("music/song%20(1).mp3")), "WebDAV PUT uses the resolved final path");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main();
