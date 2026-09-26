// POST /storage/files/upload conflict handling and idempotent registration.
// Run: npx tsx test/internal/upload_conflicts.test.ts

import { Hono } from "hono";
import { filesRoutes } from "../../worker/src/endpoints/storage/files";
import { issueUploadMetadataCapability } from "../../worker/src/utils/uploadMetadataCapability";
import { consumeReadableStream, installFixedLengthStream } from "../helpers/fixedLengthStream";

installFixedLengthStream();

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

function makeBucket(entries: Array<string | [string, number]> = [], beforePut?: (key: string) => Promise<void>) {
  const sizes = new Map(entries.map((entry) => Array.isArray(entry) ? entry : [entry, 4]));
  const objects = new Set(sizes.keys());
  const puts: string[] = [];
  return {
    objects,
    puts,
    async head(key: string) { return objects.has(key) ? { key, size: sizes.get(key) || 0 } : null; },
    async get(key: string) { return objects.has(key) ? { key } : null; },
    async put(key: string, body?: unknown) {
      await beforePut?.(key);
      await consumeReadableStream(body);
      objects.add(key); sizes.set(key, 4); puts.push(key); return { key, size: 4 };
    },
    async delete(key: string) { objects.delete(key); sizes.delete(key); },
    async list() { return { objects: [...objects].map((key) => ({ key, size: sizes.get(key) || 0 })), truncated: false }; },
  };
}

function makeDb(existingUri?: string, existingPath = "song.mp3", editTagsAllowed = true, orphanEntry = false) {
  const calls: string[] = [];
  const queueCalls: unknown[][] = [];
  const markerCalls: unknown[][] = [];
  const storageObjectIds = new Set<string>();
  let masterInserts = 0;
  let instanceInserts = 0;
  let updates = 0;
  let instanceTagScanned = 0;
  let queueStatus: string | null = null;
  let queuePayload: string | null = null;
  let markerPayload: string | null = null;
  let markerStatus: string | null = null;
  let failInstanceUpdate = false;
  let failInstanceInsert = false;
  let failEntryRegistration = false;
  let entryInstanceId: string | null = existingUri ? "si-existing" : null;
  let entryPhysicalKey = "objects/existing.mp3";
  let entryObjectId = "obj-existing";
  let instanceObjectId: string | null = existingUri ? "obj-existing" : null;
  let onPathLease: (() => void) | null = null;
  let registeredInstance: { id: string; master_id: string; storage_uri: string } | null = null;
  const db = {
    calls,
    queueCalls,
    markerCalls,
    get masterInserts() { return masterInserts; },
    get instanceInserts() { return instanceInserts; },
    get updates() { return updates; },
    get instanceTagScanned() { return instanceTagScanned; },
    set instanceTagScanned(value: number) { instanceTagScanned = value; },
    get queueStatus() { return queueStatus; },
    set queueStatus(value: string | null) { queueStatus = value; },
    get queuePayload() { return queuePayload; },
    set queuePayload(value: string | null) { queuePayload = value; },
    set markerPayload(value: string | null) { markerPayload = value; },
    get markerStatus() { return markerStatus; },
    set failInstanceUpdate(value: boolean) { failInstanceUpdate = value; },
    set failInstanceInsert(value: boolean) { failInstanceInsert = value; },
    set failEntryRegistration(value: boolean) { failEntryRegistration = value; },
    set onPathLease(value: (() => void) | null) { onPathLease = value; },
    set entryPhysicalKey(value: string) { entryPhysicalKey = value; },
    set entryObjectId(value: string) { entryObjectId = value; },
    prepare(sql: string) {
      const compact = sql.replace(/\s+/g, " ").trim();
      const statement = {
        args: [] as unknown[],
        bind(...args: unknown[]) { statement.args = args; return statement; },
        async first<T = unknown>(): Promise<T | null> {
          calls.push(compact);
          if (compact.includes("COUNT(*) FROM song_instances WHERE storage_object_id")) {
            return { instance_refs: Number(instanceObjectId === statement.args[0]), entry_refs: Number(entryObjectId === statement.args[1]) } as T;
          }
          if (compact.includes("FROM work_queue WHERE id = ?")) {
            if (compact.includes("manual_upload_pending")) return markerPayload ? { payload: markerPayload } as T : null;
            return queueStatus ? { status: queueStatus, payload: queuePayload } as T : null;
          }
          if (compact.includes("FROM song_instances si") && compact.includes("cover_r2_key")) {
            return {
              id: "si-existing", master_id: "sm-existing", storage_uri: existingUri || "r2://new/song.mp3",
              suffix: "mp3", size: 4, tag_scanned: instanceTagScanned, missing: 0, cover_r2_key: null,
            } as T;
          }
          if (compact.includes("FROM song_instances WHERE storage_uri")) {
            return existingUri === statement.args[0] ? { id: "si-existing", master_id: "sm-existing", storage_uri: existingUri } as T : null;
          }
          if (compact.includes("FROM song_instances WHERE id = ?")) {
            if (existingUri) return { id: "si-existing", master_id: "sm-existing", storage_uri: existingUri } as T;
            return registeredInstance?.id === statement.args[0] ? registeredInstance as T : null;
          }
          if (compact.includes("FROM storage_entries e") && compact.includes("e.path = ?")) {
            if ((existingUri || orphanEntry) && existingPath === statement.args[1]) {
              return { id: "entry-existing", source_id: "r2-local", parent_id: null, path: existingPath, display_name: "song.mp3", kind: "file", object_id: entryObjectId, instance_id: entryInstanceId, companion_of: null, physical_key: entryPhysicalKey, object_suffix: "mp3", object_content_type: "audio/mpeg", object_size: 10 } as T;
            }
            return null;
          }
          if (compact.includes("FROM storage_sources")) {
            return { id: "webdav", base_url: "https://dav.test", username: "writer", password: "secret", root_path: "" } as T;
          }
          if (compact.includes("FROM user_permissions")) {
            return { enabled: statement.args[1] === "edit_tags" ? Number(editTagsAllowed) : 1, max_rph: 0 } as T;
          }
          return null;
        },
        async all<T = unknown>() { calls.push(compact); return { results: [] as T[], success: true, meta: {} }; },
        async run() {
          calls.push(compact);
          let changes = 1;
          if (failInstanceUpdate && compact.startsWith("UPDATE song_instances")) throw new Error("simulated D1 registration failure");
          if (compact.includes("INTO work_queue") && compact.includes("manual_upload_pending")) {
            markerCalls.push([...statement.args]);
            if (markerStatus === "claimed") changes = 0;
            else { markerPayload = statement.args[1] as string; markerStatus = "claimed"; if (String(statement.args[0]).startsWith("wm-upload-path-")) onPathLease?.(); }
          } else if (compact.startsWith("UPDATE work_queue SET status = ?") && compact.includes("manual_upload_pending")) {
            if (markerStatus === "claimed" && markerPayload === statement.args[2]) markerStatus = statement.args[0] as string;
            else changes = 0;
          } else if (compact.includes("INTO work_queue") && compact.includes("required_caps")) {
            queueCalls.push([...statement.args]);
            queueStatus = "queued";
            queuePayload = statement.args[1] as string;
          }
          if (compact.startsWith("INSERT INTO storage_objects")) {
            storageObjectIds.add(statement.args[0] as string);
          }
          if (compact.startsWith("INSERT INTO song_masters")) masterInserts++;
          if (compact.startsWith("INSERT INTO song_instances")) {
            if (failInstanceInsert) throw new Error("simulated D1 instance insert failure");
            if (statement.args[4] && !storageObjectIds.has(statement.args[4] as string)) throw new Error("FOREIGN KEY constraint failed");
            instanceInserts++;
            registeredInstance = { id: String(statement.args[0]), master_id: String(statement.args[1]), storage_uri: String(statement.args[3]) };
            instanceObjectId = statement.args[4] as string | null;
          }
          if (compact.startsWith("INSERT INTO storage_entries")) {
            if (failEntryRegistration) throw new Error("simulated D1 entry registration failure");
            entryInstanceId = statement.args[6] as string | null;
            entryObjectId = statement.args[5] as string;
            entryPhysicalKey = `objects/${String(statement.args[5])}.mp3`;
          }
          if (compact.startsWith("UPDATE song_instances")) {
            if (compact.includes("storage_object_id") && statement.args[2] && !storageObjectIds.has(statement.args[2] as string)) throw new Error("FOREIGN KEY constraint failed");
            if (compact.includes("storage_object_id")) instanceObjectId = statement.args[2] as string | null;
            updates++;
          }
          if (compact.startsWith("UPDATE work_queue SET payload")) queuePayload = statement.args[0] as string;
          return { success: true, meta: { changes } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  return db;
}

function makeUpload(bucket: ReturnType<typeof makeBucket>, db: ReturnType<typeof makeDb>, extraEnv: Record<string, unknown> = {}, level = 3) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "root", level, enabled: 1, password: "x" });
    return next();
  });
  app.route("/storage", filesRoutes);
  return async (source: "r2" | "webdav", conflict?: string, path?: string, name = "song.mp3", directMetadata = false) => {
    const query = new URLSearchParams({ name, source });
    if (conflict) query.set("conflict", conflict);
    if (path !== undefined) query.set("path", path);
    if (directMetadata) query.set("metadata", "direct");
    const response = await app.fetch(new Request(`http://test/storage/files/upload?${query}`, {
      method: "POST", headers: { "Content-Length": "4", "Content-Type": "audio/mpeg" }, body: new Uint8Array([1, 2, 3, 4]),
    }), { DB: db, MUSIC_BUCKET: bucket, ...extraEnv });
    return { status: response.status, body: await response.json() as Record<string, any>, db };
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
  console.log("R2 audio storage-object foreign key:");
  {
    const result = await makeUpload(makeBucket(), makeDb())("r2");
    assert(result.status === 200, "new R2 audio creates its storage object before its instance");
  }

  console.log("browser direct metadata avoids the automatic queue; API upload retains queue fallback:");
  {
    const key = "test-only-hmac-key-with-sufficient-entropy";
    const directDb = makeDb();
    const direct = await makeUpload(makeBucket(), directDb, { WORK_UPLOAD_HMAC_KEY: key })("r2", undefined, undefined, "direct.mp3", true);
    assert(direct.status === 200 && typeof direct.body.metadataToken === "string", "direct browser upload receives a scoped capability");
    assert(directDb.queueCalls.length === 0, "successful direct-parse path creates no mandatory duplicate metadata task");
    assert(directDb.markerCalls.length === 1, "direct upload persists a recoverable pending marker");
    assert(direct.body.metadataStatus === "direct", "response marks direct metadata mode");

    const apiDb = makeDb();
    const api = await makeUpload(makeBucket(), apiDb, { WORK_UPLOAD_HMAC_KEY: key })("r2", undefined, undefined, "api.mp3");
    assert(api.status === 200 && apiDb.queueCalls.length === 1, "API upload gets one server-side metadata fallback task");
    assert(apiDb.queueCalls[0][4] === 5, "API metadata fallback uses background priority");

    const noKeyDb = makeDb();
    const noKey = await makeUpload(makeBucket(), noKeyDb)("r2", undefined, undefined, "no-key.mp3", true);
    assert(noKey.status === 200 && !noKey.body.metadataToken && noKeyDb.queueCalls.length === 1,
      "missing HMAC secret fails closed and retains server-side queue fallback");
  }

  console.log("upload metadata fallback requires a scoped capability and is deduplicated by instance:");
  {
    const db = makeDb("r2://objects/song.mp3");
    const app = new Hono<{ Bindings: any; Variables: any }>();
    app.use("*", async (c, next) => {
      c.set("user", { username: "root", level: 3, enabled: 1, password: "x" });
      return next();
    });
    app.route("/storage", filesRoutes);
    const env = { DB: db, WORK_UPLOAD_HMAC_KEY: "test-only-hmac-key-with-sufficient-entropy" };
    const nonce = "fallback-generation";
    db.markerPayload = JSON.stringify({ instanceId: "si-existing", storageUri: "r2://objects/song.mp3", uploadNonce: nonce });
    const token = await issueUploadMetadataCapability(env as any, "root", "si-existing", "r2://objects/song.mp3", nonce);
    const post = async (body: unknown) => app.fetch(new Request("http://test/storage/files/upload-metadata-fallback", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), env);
    const bad = await post({ instanceId: "si-existing", token: await issueUploadMetadataCapability(env as any, "other", "si-existing", "r2://objects/song.mp3", nonce) });
    assert(bad.status === 403, "cross-account fallback request rejected");
    const first = await post({ instanceId: "si-existing", token });
    const firstBody = await first.json() as any;
    const second = await post({ instanceId: "si-existing", token });
    const secondBody = await second.json() as any;
    assert(first.status === 200 && firstBody.queued, "valid upload capability queues the fallback");
    assert(second.status === 200 && secondBody.taskId === firstBody.taskId, "fallback replay resolves to same deduplicated task id");
    assert(db.queueCalls.length === 1 && db.queueCalls[0][0] === firstBody.taskId, "queued fallback replay does not create another task");
    db.instanceTagScanned = 1;
    db.queueStatus = "claimed";
    db.queuePayload = JSON.stringify({ instanceId: "si-existing", sourceUri: "r2://objects/old.mp3", suffix: "mp3", size: 4, origin: "upload", uploadNonce: nonce });
    const staleClaimedRetry = await post({ instanceId: "si-existing", token, coverRetry: true });
    assert(staleClaimedRetry.status === 409, "stale claimed task is not reported as an adequate fallback");
    db.queuePayload = JSON.stringify({ instanceId: "si-existing", sourceUri: "r2://objects/song.mp3", suffix: "mp3", size: 4, origin: "upload", uploadNonce: nonce });
    const claimedRetry = await post({ instanceId: "si-existing", token, coverRetry: true });
    const claimedRetryBody = await claimedRetry.json() as any;
    assert(claimedRetryBody.claimed && db.queueCalls.length === 1, "cover retry leaves an active claimed task untouched");
    db.queueStatus = "completed";
    const coverRetry = await post({ instanceId: "si-existing", token, coverRetry: true });
    const coverRetryBody = await coverRetry.json() as any;
    assert(coverRetry.status === 200 && coverRetryBody.queued, "cover write failure can queue a cover retry after direct tags were applied");
    assert(db.queueCalls.length === 2 && db.calls.some((sql) => sql.includes("ON CONFLICT(id) DO UPDATE") && sql.includes("WHERE work_queue.status IN ('completed', 'failed', 'canceled')")),
      "completed dedup history is safely requeued without touching claimed work");
  }

  console.log("R2 conflict contract:");
  {
    const bucket = makeBucket(["objects/existing.mp3"]);
    const db = makeDb("r2://objects/existing.mp3");
    const result = await makeUpload(bucket, db)("r2");
    assert(result.status === 409, "default policy rejects an existing R2 object");
    assert(result.body.conflict?.requestedKey === "song.mp3", "conflict response identifies the requested key");
    assert(result.body.conflict?.policies?.join(",") === "error,overwrite,rename", "conflict response advertises every supported policy");
    assert(bucket.puts.length === 0, "reject never overwrites the object");
  }
  {
    const bucket = makeBucket([["objects/existing.mp3", 10]]);
    const result = await makeUpload(bucket, makeDb("r2://objects/existing.mp3"), { R2_MAX_LIMIT: "12" })("r2", "overwrite");
    assert(result.status === 200, "overwrite storage projection subtracts the old object size");
  }
  {
    const result = await checkConflicts(makeBucket(["objects/existing.mp3"]), makeDb("r2://objects/existing.mp3"));
    assert(result.status === 200 && result.body.conflicts?.length === 1, "batch preflight returns only the conflicting files");
    assert(result.body.items?.[1]?.key === "Album/new.flac" && result.body.items?.[1]?.conflict === false, "batch preflight returns each final path");
  }
  {
    const bucket = makeBucket(["objects/existing.mp3"]);
    const result = await makeUpload(bucket, makeDb("r2://objects/existing.mp3"))("r2", "rename");
    assert(result.status === 200 && /^objects\/obj_[0-9a-f]{16}\.mp3$/.test(result.body.key), "rename allocates a fresh stable R2 key");
    assert(result.body.conflict?.renamed === true && result.body.conflict?.finalKey === "song (1).mp3", "success reports the final logical path");
  }

  console.log("overwrite reuses the registered original instance:");
  {
    const bucket = makeBucket(["objects/existing.mp3"]);
    const db = makeDb("r2://objects/existing.mp3");
    const result = await makeUpload(bucket, db)("r2", "overwrite");
    assert(result.status === 200 && result.body.id === "si-existing", "overwrite returns the existing instance id");
    assert(db.updates === 2, "overwrite invalidates old metadata before writing and refreshes the existing instance");
    assert(db.masterInserts === 0 && db.instanceInserts === 0, "overwrite creates neither a master nor an instance duplicate");
  }

  console.log("same-path overwrites serialize through the physical PUT:");
  {
    let signalEntered!: () => void;
    let resumePut!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const resume = new Promise<void>((resolve) => { resumePut = resolve; });
    let blocked = false;
    const bucket = makeBucket(["objects/existing.mp3"], async () => {
      if (blocked) return;
      blocked = true;
      signalEntered();
      await resume;
    });
    const db = makeDb("r2://objects/existing.mp3");
    const upload = makeUpload(bucket, db);
    const first = upload("r2", "overwrite");
    await entered.promise;
    const second = await upload("r2", "overwrite");
    assert(second.status === 409 && bucket.puts.length === 0, "second overwrite is rejected before its PUT while first owns the generation");
    resumePut();
    const firstResult = await first;
    assert(firstResult.status === 200 && bucket.puts.length === 1, "first overwrite completes under its exclusive generation");
    assert(db.markerStatus === "canceled", "successful upload releases its marker for direct metadata submission");
  }

  console.log("orphan R2 entries serialize overwrite and link only one new instance:");
  {
    let signalEntered!: () => void;
    let resumePut!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const gate = new Promise<void>((resolve) => { resumePut = resolve; });
    let paused = false;
    const bucket = makeBucket(["objects/existing.mp3"], async () => {
      if (paused) return;
      paused = true;
      signalEntered();
      await gate;
    });
    const db = makeDb(undefined, "song.mp3", true, true);
    const upload = makeUpload(bucket, db);
    const first = upload("r2", "overwrite");
    await entered;
    const second = await upload("r2", "overwrite");
    assert(second.status === 409 && bucket.puts.length === 0, "second orphan-entry overwrite is rejected before PUT");
    resumePut();
    const firstResult = await first;
    assert(firstResult.status === 200 && db.instanceInserts === 1, "first orphan-entry overwrite registers one instance");
    const retry = await upload("r2", "overwrite");
    assert(retry.status === 200 && db.instanceInserts === 1, "later overwrite reuses the instance linked by the first request");
  }

  console.log("orphan R2 entry insert failure removes only the new candidate:");
  {
    const bucket = makeBucket(["objects/existing.mp3"]);
    const db = makeDb(undefined, "song.mp3", true, true);
    bucket.put = async (key: string, body?: unknown) => {
      await consumeReadableStream(body);
      bucket.objects.add(key);
      bucket.puts.push(key);
      db.failInstanceInsert = true;
      return { key, size: 4 };
    };
    const result = await makeUpload(bucket, db)("r2", "overwrite");
    assert(result.status === 500, "orphan overwrite registration error is reported");
    assert(bucket.objects.size === 1 && bucket.objects.has("objects/existing.mp3"), "failed registration deletes only its fresh key and preserves the previous object");
    assert(db.instanceInserts === 0, "failed registration does not create a duplicate instance");
  }

  console.log("orphan R2 overwrite rejects a changed path snapshot before PUT:");
  {
    const bucket = makeBucket(["objects/existing.mp3"]);
    const db = makeDb(undefined, "song.mp3", true, true);
    db.onPathLease = () => {
      db.entryObjectId = "obj-replaced";
      db.entryPhysicalKey = "objects/replaced.mp3";
    };
    const result = await makeUpload(bucket, db)("r2", "overwrite");
    assert(result.status === 409 && bucket.puts.length === 0, "changed orphan target is rejected before the physical PUT");
    assert(db.markerStatus === "canceled", "stale-path rejection releases the path lease");
  }

  console.log("R2 overwrite cleans an unreferenced new candidate after D1 registration fails:");
  {
    const bucket = makeBucket(["objects/existing.mp3"]);
    const db = makeDb("r2://objects/existing.mp3");
    bucket.put = async (key: string, body?: unknown) => {
      await consumeReadableStream(body);
      bucket.objects.add(key);
      db.failInstanceUpdate = true;
      return { key, size: 4 };
    };
    const result = await makeUpload(bucket, db)("r2", "overwrite");
    assert(result.status === 500, "post-PUT D1 registration error is reported");
    assert(bucket.objects.size === 1 && bucket.objects.has("objects/existing.mp3"), "unreferenced new bytes are removed and previous bytes remain");
    assert(db.instanceTagScanned === 0 && db.markerStatus === "canceled", "unscanned marker remains recoverable after the database error");
  }

  console.log("R2 overwrite preserves a new candidate once its instance references it:");
  {
    const bucket = makeBucket(["objects/existing.mp3"]);
    const db = makeDb("r2://objects/existing.mp3");
    bucket.put = async (key: string, body?: unknown) => {
      await consumeReadableStream(body);
      bucket.objects.add(key);
      db.failEntryRegistration = true;
      return { key, size: 4 };
    };
    const result = await makeUpload(bucket, db)("r2", "overwrite");
    assert(result.status === 500, "entry registration failure is reported");
    assert(bucket.objects.size === 2 && bucket.objects.has("objects/existing.mp3"), "candidate remains when the instance already references it");
  }

  console.log("upload permission cannot overwrite audio owned by an existing instance without edit_tags:");
  {
    const bucket = makeBucket(["objects/existing.mp3"]);
    const db = makeDb("r2://objects/existing.mp3", "song.mp3", false);
    const result = await makeUpload(bucket, db, {}, 2)("r2", "overwrite");
    assert(result.status === 403, "protected audio overwrite is rejected before replacing bytes");
    assert(bucket.puts.length === 0, "protected overwrite leaves the existing object untouched");
  }

  console.log("WebDAV receives the same server-side decision:");
  {
    const originalFetch = globalThis.fetch;
    const methods: Array<{ method: string; url: string }> = [];
    const uploaded = new Set<string>();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method || "GET";
      const url = String(input);
      methods.push({ method, url });
      if (method === "HEAD") {
        const exists = uploaded.has(url) || !url.includes("song%20(1).mp3");
        return new Response(null, { status: exists ? 200 : 404, headers: exists ? { "Content-Length": "4" } : {} });
      }
      if (method === "PUT") uploaded.add(url);
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    const simulatedWebDavFetch = globalThis.fetch;
    try {
      const bucket = makeBucket();
      const db = makeDb();
      const upload = makeUpload(bucket, db);
      const noEditUpload = makeUpload(bucket, makeDb(undefined, "song.mp3", false), {}, 2);
      const protectedOrphanOverwrite = await noEditUpload("webdav", "overwrite");
      assert(protectedOrphanOverwrite.status === 403, "upload-only user cannot overwrite a physically existing WebDAV object without a D1 instance row");
      assert(!methods.some((call) => call.method === "PUT"), "orphan overwrite rejection happens before WebDAV PUT");
      methods.length = 0;
      const registeredDb = makeDb("webdav://webdav/song.mp3");
      let generationReadyAtPut = false;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method || "GET";
        methods.push({ method, url: String(input) });
        if (method === "HEAD") {
          const exists = uploaded.has(String(input)) || !String(input).includes("song%20(1).mp3");
          return new Response(null, { status: exists ? 200 : 404, headers: exists ? { "Content-Length": "4" } : {} });
        }
        if (method === "PUT") {
          generationReadyAtPut = registeredDb.markerCalls.length === 1 && registeredDb.updates === 1;
          uploaded.add(String(input));
          return new Response(null, { status: 201 });
        }
        return new Response(null, { status: 200 });
      }) as typeof fetch;
      const registeredOverwrite = await makeUpload(bucket, registeredDb)("webdav", "overwrite");
      assert(registeredOverwrite.status === 200 && generationReadyAtPut, "existing WebDAV overwrite persists its generation and resets tag_scanned before PUT");
      methods.length = 0;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method || "GET";
        methods.push({ method, url: String(input) });
        return new Response(null, { status: method === "HEAD" ? 200 : method === "PUT" ? 500 : 200, headers: { "Content-Length": "4" } });
      }) as typeof fetch;
      const failedDb = makeDb("webdav://webdav/song.mp3");
      const failedOverwrite = await makeUpload(bucket, failedDb)("webdav", "overwrite");
      assert(failedOverwrite.status === 500 && failedDb.markerCalls.length === 1 && failedDb.updates === 1,
        "failed WebDAV PUT retains the prewrite generation marker and unscanned state for recovery");
      globalThis.fetch = simulatedWebDavFetch;
      methods.length = 0;
      const rejected = await upload("webdav");
      assert(rejected.status === 409, "default policy rejects an existing WebDAV object");
      assert(!methods.some((call) => call.method === "PUT"), "rejected WebDAV upload does not PUT");
      methods.length = 0;
      const renamed = await upload("webdav", "rename");
      assert(renamed.status === 200 && renamed.body.key === "song (1).mp3", "WebDAV rename chooses an available path");
      assert(methods.some((call) => call.method === "PUT" && call.url.endsWith("song%20(1).mp3")), "WebDAV PUT uses the resolved final path");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  console.log("upload path boundary:");
  {
    const upload = makeUpload(makeBucket(), makeDb());
    for (const [path, name] of [["../private", "song.mp3"], ["album//disc", "song.mp3"], ["album", "../song.mp3"], ["album", "song\\name.mp3"]] as const) {
      const result = await upload("r2", undefined, path, name);
      assert(result.status === 400, `route rejects unsafe upload path/name ${path}/${name}`);
    }
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main();
