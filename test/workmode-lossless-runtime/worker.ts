import { Hono } from "hono";
import { workLosslessRoutes } from "../../worker/src/endpoints/edgesonic/work_lossless";
import { workRoutes } from "../../worker/src/endpoints/edgesonic/work";
import { signUploadToken } from "../../worker/src/utils/workUploadToken";

interface Bindings {
  DB: D1Database;
  MUSIC_BUCKET: R2Bucket;
  INSTANCE_ID: string;
  WORK_UPLOAD_HMAC_KEY: string;
}

interface User {
  username: string;
  level: number;
}

const user: User = { username: "runtime-fixture", level: 3 };
const app = new Hono<{ Bindings: Bindings; Variables: { user: User } }>();

app.use("*", async (c, next) => {
  c.set("user", user);
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Headers", "Content-Type, X-Work-Attempt, X-Work-Claimed-At, X-Source-SHA256, X-Source-PCM-SHA256, X-Output-SHA256, X-Output-PCM-SHA256, X-Verification-JSON");
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  return next();
});

app.get("/__fixture/health", (c) => c.json({ ok: true, runtime: "workerd" }));

app.post("/__fixture/init", async (c) => {
  const schema = [
    `CREATE TABLE IF NOT EXISTS storage_objects (
      id TEXT PRIMARY KEY, physical_key TEXT NOT NULL UNIQUE, legacy_key TEXT UNIQUE,
      suffix TEXT NOT NULL, content_type TEXT, size INTEGER NOT NULL, etag TEXT,
      created_at INTEGER, updated_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS song_instances (
      id TEXT PRIMARY KEY, master_id TEXT NOT NULL, source_id TEXT NOT NULL,
      source_type TEXT NOT NULL, storage_uri TEXT NOT NULL, storage_object_id TEXT,
      suffix TEXT NOT NULL, content_type TEXT, bit_rate INTEGER, sample_rate INTEGER,
      bit_depth INTEGER, channels INTEGER, duration INTEGER, size INTEGER, missing INTEGER,
      tag_scanned INTEGER, source_etag TEXT, source_last_modified INTEGER,
      created_at INTEGER, updated_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS storage_entries (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, parent_id TEXT, path TEXT NOT NULL,
      display_name TEXT NOT NULL, kind TEXT NOT NULL, object_id TEXT, instance_id TEXT,
      companion_of TEXT, created_at INTEGER, updated_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS work_queue (
      id TEXT PRIMARY KEY, task_type TEXT NOT NULL, payload TEXT NOT NULL,
      required_caps TEXT, priority INTEGER NOT NULL, status TEXT NOT NULL,
      claimed_by TEXT, claimed_at INTEGER, heartbeat_at INTEGER, result_json TEXT,
      error_message TEXT, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
      created_at INTEGER, expires_at INTEGER
    )`,
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_test_entry_path ON storage_entries(source_id, path)",
  ];
  await c.env.DB.batch(schema.map((sql) => c.env.DB.prepare(sql)));
  return c.json({ ok: true });
});

app.post("/__fixture/seed", async (c) => {
  const source = new Uint8Array(await c.req.arrayBuffer());
  if (source.byteLength < 44) return c.json({ ok: false, error: "Expected generated WAV bytes" }, 400);
  const id = crypto.randomUUID();
  const instanceId = `si-fixture-${id}`;
  const taskId = `wt-lossless-${instanceId}`;
  const objectId = `so-fixture-${id}`;
  const companionObjectId = `so-companion-${id}`;
  const entryId = `se-fixture-${id}`;
  const companionEntryId = `se-companion-${id}`;
  const masterId = `sm-fixture-${id}`;
  const userRefInstanceId = `si-user-ref-${id}`;
  const entryPath = `Generated/${id}/Fixture.wav`;
  const sourceKey = `fixtures/${id}.wav`;
  const sourceUri = `r2://${sourceKey}`;
  const sourceObject = await c.env.MUSIC_BUCKET.put(sourceKey, source, {
    httpMetadata: { contentType: "audio/wav" },
  });
  const companionKey = `fixtures/${id}.lrc`;
  const companionBytes = new TextEncoder().encode("[00:00.00]generated fixture sidecar\n");
  const companionObject = await c.env.MUSIC_BUCKET.put(companionKey, companionBytes, {
    httpMetadata: { contentType: "text/plain" },
  });
  const sourceEtag = sourceObject.etag;
  const now = Math.floor(Date.now() / 1000);
  const attempts = 2;
  const claimedAt = now;
  const payload = { instanceId, sourceUri, sourceSize: source.byteLength, sourceEtag, sourceObjectId: objectId };
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO storage_objects (id, physical_key, suffix, content_type, size, etag, created_at, updated_at)
      VALUES (?, ?, 'wav', 'audio/wav', ?, ?, ?, ?)`).bind(objectId, sourceKey, source.byteLength, sourceEtag, now, now),
    c.env.DB.prepare(`INSERT INTO storage_objects (id, physical_key, suffix, content_type, size, etag, created_at, updated_at)
      VALUES (?, ?, 'lrc', 'text/plain', ?, ?, ?, ?)`).bind(companionObjectId, companionKey, companionBytes.byteLength, companionObject.etag, now, now),
    c.env.DB.prepare(`INSERT INTO song_instances
      (id, master_id, source_id, source_type, storage_uri, storage_object_id, suffix, content_type,
       sample_rate, bit_depth, channels, duration, size, missing, tag_scanned, source_etag, created_at, updated_at)
      VALUES (?, ?, 'r2-local', 'original', ?, ?, 'wav', 'audio/wav', 44100, 16, 2, 5, ?, 0, 1, ?, ?, ?)`)
      .bind(instanceId, masterId, sourceUri, objectId, source.byteLength, sourceEtag, now, now),
    c.env.DB.prepare(`INSERT INTO song_instances
      (id, master_id, source_id, source_type, storage_uri, storage_object_id, suffix, content_type, size, missing)
      VALUES (?, ?, 'legacy-source', 'original', ?, NULL, 'mp3', 'audio/mpeg', 128000, 0)`)
      .bind(userRefInstanceId, masterId, `legacy://user-reference/${id}.mp3`),
    c.env.DB.prepare(`INSERT INTO storage_entries
      (id, source_id, path, display_name, kind, object_id, instance_id, created_at, updated_at)
      VALUES (?, 'r2-local', ?, 'Fixture.wav', 'file', ?, ?, ?, ?)`)
      .bind(entryId, entryPath, objectId, instanceId, now, now),
    c.env.DB.prepare(`INSERT INTO storage_entries
      (id, source_id, path, display_name, kind, object_id, companion_of, created_at, updated_at)
      VALUES (?, 'r2-local', ?, 'Fixture.lrc', 'file', ?, ?, ?, ?)`)
      .bind(companionEntryId, entryPath.replace(/\.wav$/i, ".lrc"), companionObjectId, entryId, now, now),
    c.env.DB.prepare(`INSERT INTO work_queue
      (id, task_type, payload, required_caps, priority, status, claimed_by, claimed_at, heartbeat_at,
       attempts, max_attempts, created_at)
      VALUES (?, 'lossless', ?, '["ffmpeg"]', 5, 'claimed', ?, ?, ?, ?, 3, ?)`)
      .bind(taskId, JSON.stringify(payload), user.username, claimedAt, claimedAt, attempts, now),
  ]);
  const token = await signUploadToken(c.env as unknown as Env, taskId);
  const params = new URLSearchParams({ id: taskId, token, attempts: String(attempts), claimedAt: String(claimedAt) });
  const sourceUrl = new URL(`/edgesonic/work/lossless/source?${params}`, c.req.url).toString();
  const uploadUrl = new URL(`/edgesonic/work/lossless/upload?${params}`, c.req.url).toString();
  return c.json({
    id: taskId, token, attempts, claimedAt, instanceId, sourceUri, sourceSize: source.byteLength,
    sourceEtag, sourceObjectId: objectId, sourceKey, entryId, entryPath,
    masterId, userRefInstanceId, companionObjectId, companionEntryId, companionKey,
    streamUrl: sourceUrl, sourceUrl, uploadUrl, submitUrl: new URL("/edgesonic/work/submit", c.req.url).toString(),
    heartbeatUrl: new URL("/edgesonic/work/heartbeat", c.req.url).toString(),
  });
});

app.post("/__fixture/mutate", async (c) => {
  const body = await c.req.json<{ id: string; mode: "claim" | "snapshot" | "collision" | "shared" | "legacy" | "uppercase" }>();
  if (body.mode === "claim") {
    await c.env.DB.prepare("UPDATE work_queue SET attempts = attempts + 1 WHERE id = ?").bind(body.id).run();
  } else if (body.mode === "snapshot") {
    await c.env.DB.prepare("UPDATE storage_objects SET etag = 'changed-etag' WHERE id = (SELECT json_extract(payload, '$.sourceObjectId') FROM work_queue WHERE id = ?)").bind(body.id).run();
  } else if (body.mode === "uppercase") {
    await c.env.DB.prepare("UPDATE song_instances SET suffix = 'WAV' WHERE id = (SELECT json_extract(payload, '$.instanceId') FROM work_queue WHERE id = ?)").bind(body.id).run();
  } else if (body.mode === "collision" || body.mode === "shared" || body.mode === "legacy") {
    const row = await c.env.DB.prepare("SELECT payload FROM work_queue WHERE id = ?").bind(body.id).first<{ payload: string }>();
    if (!row) return c.json({ ok: false }, 404);
    const payload = JSON.parse(row.payload) as { instanceId: string; sourceObjectId: string };
    if (body.mode === "collision") {
      await c.env.DB.prepare(`INSERT INTO storage_entries
        (id, source_id, path, display_name, kind, object_id, created_at, updated_at)
        VALUES (?, 'r2-local', ?, 'Fixture.flac', 'file', ?, unixepoch(), unixepoch())`)
        .bind(`se-collision-${body.id}`, `Generated/${body.id.slice("wt-lossless-si-fixture-".length)}/Fixture.flac`, payload.sourceObjectId).run();
    } else if (body.mode === "shared") {
      await c.env.DB.prepare(`INSERT INTO song_instances
        (id, master_id, source_id, source_type, storage_uri, storage_object_id, suffix, content_type, size, missing)
        VALUES (?, 'sm-shared', 'r2-local', 'original', ?, ?, 'wav', 'audio/wav', 1, 0)`)
        .bind(`si-shared-${body.id}`, `r2://legacy/${body.id}.wav`, payload.sourceObjectId).run();
    } else {
      const instance = await c.env.DB.prepare("SELECT storage_uri FROM song_instances WHERE id = ?")
        .bind(payload.instanceId).first<{ storage_uri: string }>();
      await c.env.DB.prepare(`INSERT INTO song_instances
        (id, master_id, source_id, source_type, storage_uri, storage_object_id, suffix, content_type, size, missing)
        VALUES (?, 'sm-legacy', 'legacy-source', 'original', ?, NULL, 'wav', 'audio/wav', 1, 0)`)
        .bind(`si-legacy-${body.id}`, instance?.storage_uri).run();
    }
  } else return c.json({ ok: false }, 400);
  return c.json({ ok: true });
});

app.get("/__fixture/state", async (c) => {
  const id = c.req.query("id") || "";
  const task = await c.env.DB.prepare("SELECT status, attempts, result_json, error_message FROM work_queue WHERE id = ?")
    .bind(id).first();
  const instance = await c.env.DB.prepare(`SELECT si.*, o.id AS object_id, o.physical_key, o.size AS object_size, o.etag AS object_etag
    FROM song_instances si LEFT JOIN storage_objects o ON o.id = si.storage_object_id WHERE si.id =
      (SELECT json_extract(payload, '$.instanceId') FROM work_queue WHERE id = ?)`)
    .bind(id).first();
  const relatedInstances = (await c.env.DB.prepare(`SELECT id, master_id, storage_uri, storage_object_id
    FROM song_instances WHERE master_id = (SELECT master_id FROM song_instances WHERE id =
      (SELECT json_extract(payload, '$.instanceId') FROM work_queue WHERE id = ?)) ORDER BY id`)
    .bind(id).all()).results;
  const entries = (await c.env.DB.prepare("SELECT id, path, display_name, object_id, instance_id FROM storage_entries ORDER BY id").all()).results;
  const companions = (await c.env.DB.prepare(`SELECT id, path, display_name, object_id, companion_of FROM storage_entries
    WHERE companion_of = (SELECT id FROM storage_entries WHERE instance_id =
      (SELECT json_extract(payload, '$.instanceId') FROM work_queue WHERE id = ?) AND kind = 'file')`)
    .bind(id).all()).results;
  const objects = (await c.env.DB.prepare("SELECT id, physical_key, legacy_key, suffix, size, etag FROM storage_objects ORDER BY id").all()).results;
  const listed = await c.env.MUSIC_BUCKET.list();
  const r2Keys = listed.objects.map((object) => ({ key: object.key, size: object.size }));
  return c.json({ task, instance, relatedInstances, entries, companions, objects, r2Keys });
});

app.route("/edgesonic", workRoutes);
app.route("/edgesonic", workLosslessRoutes);
app.onError((error, c) => c.json({ ok: false, error: error.message }, 500));

export default app;
