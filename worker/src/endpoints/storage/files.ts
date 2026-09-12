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

import { Hono } from "hono";
import { permissionMiddleware } from "../../auth";
import { getSourceCredentials } from "../../adapters/index";
import { createR2Adapter } from "../../adapters/r2";
import { createWebDAVAdapter } from "../../adapters/webdav";
import { urlAdapter } from "../../adapters/url";
import { createSubsonicAdapter } from "../../adapters/subsonic";
import { encodePath } from "./scan";
import { srcBaseUrl, type SourceRow } from "../../utils/slices";
import { PayloadTooLargeError, limitReadableStream } from "../../utils/streamLimit";
import { copyR2Object } from "../../utils/r2ObjectCopy";
import type { User } from "../../types/entities";

export const filesRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

// ── Global Files API Security Guard ──────────────────────────────────────
// All /storage/files/* operations require admin privileges (level 2+).
// This prevents level 0/1 users from accessing file management entirely.
filesRoutes.use("*", async (c, next) => {
  const user = c.get("user");
  if (user.level < 2) {
    return c.json({
      ok: false,
      error: "File operations require admin privileges (level 2+)",
    }, 403);
  }
  return next();
});

// ── Upload (raw body stream — studio-style) ──────────────────────────────
// POST /rest/files/upload?name=file.mp3&source=r2|webdav&path=music&conflict=error|overwrite|rename
//
// Upload goes directly to music/{path}/{name} on R2 (no more _uploads/
// placeholder album). We create a song_instance row with tag_scanned=0 and
// dispatch a metadata task so the browser worker pool parses the file's tags
// and relinks it to the right master/album/artist via applyMetadataResult.
// Until the metadata task completes the file is invisible in the library
// (no song_masters row) — the user can see it in the Files tree browser.
import { dispatchWork } from "../edgesonic/work";
import { getFeatureString } from "../../utils/features";
import { isDemoMode, demoMaxUploadBytes, r2MaxStorageBytes, demoR2TotalBytes, allowAllFileTypes, isAudioSuffix, isCompanionSuffix } from "../../utils/demoMode";
import { getProfile } from "../../transcode/profiles";
import { preBakeProfile } from "../../transcode/preBake";
import {
  R2_SOURCE_ID,
  ensureR2Folder,
  findR2EntryByKey,
  findR2EntryByPath,
  registerR2Object,
  stableR2Uri,
} from "../../utils/storageResolver";
import { createStableObjectId, createStableObjectKey, splitEntryPath } from "../../utils/storageObjects";

filesRoutes.post("/files/upload", permissionMiddleware("upload"), async (c) => {
  const env = c.env as Env;
  const name = c.req.query("name");
  const source = c.req.query("source") || "r2";
  const path = c.req.query("path") || "";

  const rawBody = c.req.raw.body;
  const cleanPath = normalizeUploadPath(path);
  if (!rawBody || !name || !isSafeUploadName(name) || cleanPath === null || (source !== "r2" && source !== "webdav")) {
    return c.json({ ok: false, error: "Missing file body or name" }, 400);
  }

  const contentLength = c.req.header("Content-Length");
  let sizeHeader = parseInt(contentLength || "0", 10);
  if (source === "r2") {
    if (contentLength === undefined) {
      return c.json({ ok: false, error: "Content-Length is required" }, 411);
    }
    if (!/^\d+$/.test(contentLength)) {
      return c.json({ ok: false, error: "Invalid Content-Length" }, 400);
    }
    sizeHeader = Number(contentLength);
    if (!Number.isSafeInteger(sizeHeader)) {
      return c.json({ ok: false, error: "Invalid Content-Length" }, 400);
    }
  }

  const suffix = name.split(".").pop() || "bin";
  const contentType = normalizeUploadContentType(c.req.header("Content-Type"), suffix);
  // Lyric sidecars, text and images ride along with the music they belong to;
  // everything else about this request (D1 rows, tag parsing, transcodes) is
  // audio-only.
  const isAudio = isAudioSuffix(suffix);
  // D1 owns the logical path. R2 receives a fresh immutable object key.
  const requestedPath = "music/" + (cleanPath ? cleanPath + "/" : "") + name;

  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  const cap = isDemoMode(env) ? demoMaxUploadBytes(env) : MAX_UPLOAD_BYTES;
  if (sizeHeader > cap) return c.json({ ok: false, error: "Payload too large" }, 413);

  // File-type gate. Audio plus the companion types (lyrics / text / images)
  // are always accepted. Operators can flip allow_all_file_types to "1" to
  // accept anything else too; demo mode locks that row so a visitor can't.
  const allowAll = await allowAllFileTypes(env);
  if (!allowAll && !isAudio && !isCompanionSuffix(suffix)) {
    return c.json({ ok: false, error: `File type .${suffix} not allowed` }, 415);
  }

  // Demo mode: per-upload cap. The cumulative R2 storage cap below applies
  // in both normal and demo modes.
  if (isDemoMode(env)) {
    if (sizeHeader && sizeHeader > cap) {
      return c.json({ ok: false, error: `Demo upload cap is ${cap} bytes` }, 413);
    }
  }

  const target = source === "r2"
    ? await resolveR2UploadTarget(db, requestedPath, suffix, c.req.query("conflict"))
    : await resolveUploadTarget(env, source, requestedPath, c.req.query("conflict"));
  if ("error" in target) return c.json(target.error.body, target.error.status);
  const r2Key = target.key;

  // Cumulative R2 storage guard. An overwrite replaces its old bytes, so its
  // projection subtracts the object being replaced instead of charging both.
  if (source !== "webdav") {
    const totalCap = await r2MaxStorageBytes(env);
    if (totalCap > 0) {
      const used = await demoR2TotalBytes(env.MUSIC_BUCKET);
      const oldKey = source === "r2" ? (target as R2UploadTarget).previousKey : r2Key;
      const oldSize = target.policy === "overwrite" && target.existed && oldKey
        ? (await env.MUSIC_BUCKET.head(oldKey))?.size || 0
        : 0;
      const projected = Math.max(0, used - oldSize) + (sizeHeader || 0);
      if (projected > totalCap) {
        return c.json({
          ok: false,
          error: `R2 storage limit reached: ${used}/${totalCap} bytes already used`,
        }, 413);
      }
    }
  }

  if (source === "webdav") {
    const creds = await getSourceCredentials(db, "webdav", env);
    if (!creds) return c.json({ ok: false, error: "No WebDAV source configured" }, 400);
    const fullUrl = `${creds.baseUrl.replace(/\/$/, "")}/${r2Key.split("/").map(encodeURIComponent).join("/")}`;
    let overflowed = false;
    let resp: Response;
    try {
      resp = await fetch(fullUrl, {
        method: "PUT",
        headers: {
          Authorization: `Basic ${btoa(`${creds.username}:${creds.password}`)}`,
          "Content-Type": contentType,
          ...(target.policy === "overwrite" ? {} : { "If-None-Match": "*" }),
        },
        body: limitReadableStream(rawBody, cap, undefined, () => { overflowed = true; }),
      });
    } catch (error) {
      if (overflowed || error instanceof PayloadTooLargeError) {
        try { await fetch(fullUrl, { method: "DELETE", headers: { Authorization: `Basic ${btoa(`${creds.username}:${creds.password}`)}` } }); } catch { /* remote cleanup best effort */ }
        return c.json({ ok: false, error: "Payload too large" }, 413);
      }
      throw error;
    }
    if (overflowed) {
      try { await fetch(fullUrl, { method: "DELETE", headers: { Authorization: `Basic ${btoa(`${creds.username}:${creds.password}`)}` } }); } catch { /* remote cleanup best effort */ }
      return c.json({ ok: false, error: "Payload too large" }, 413);
    }
    if (resp.status === 412) return c.json(uploadConflict(source, r2Key), 409);
    if (!resp.ok) return c.json({ ok: false, error: `WebDAV upload failed: ${resp.status}` }, 500);
    const verified = await verifyWebDavUpload(fullUrl, creds, cap);
    if (!verified.ok) return c.json({ ok: false, error: verified.error }, verified.status);
  } else {
    let overflowed = false;
    let written;
    try {
      const body = limitReadableStream(rawBody, cap, undefined, () => { overflowed = true; })
        .pipeThrough(new FixedLengthStream(sizeHeader));
      written = await env.MUSIC_BUCKET.put(r2Key, body, {
        httpMetadata: { contentType },
        ...(target.policy === "overwrite" ? {} : { onlyIf: new Headers({ "If-None-Match": "*" }) }),
      });
    } catch (error) {
      if (overflowed || error instanceof PayloadTooLargeError) {
        return c.json({ ok: false, error: "Payload too large" }, 413);
      }
      if (isContentLengthMismatch(error)) {
        return c.json({ ok: false, error: "Content-Length does not match request body" }, 400);
      }
      throw error;
    }
    if (written === null) return c.json(uploadConflict(source, r2Key), 409);
    if (overflowed || (written?.size ?? 0) > cap) {
      return c.json({ ok: false, error: "Payload too large" }, 413);
    }
  }

  const r2Target = source === "r2" ? target as R2UploadTarget : null;

  // A companion file is just bytes plus a D1 entry. It has no song row, no tag
  // parse and no transcode; its relation to an audio entry is resolved from
  // the logical D1 path instead of a physical-key suffix replacement.
  if (!isAudio) {
    if (r2Target) {
      await registerR2Object(db, {
        objectId: r2Target.objectId,
        physicalKey: r2Key,
        legacyKey: null,
        logicalPath: r2Target.logicalPath,
        suffix,
        contentType,
        size: sizeHeader || 0,
      });
      await cleanupStorageObject(db, r2Target.previousEntry?.object_id || null);
      if (r2Target.previousKey && r2Target.previousKey !== r2Key) await env.MUSIC_BUCKET.delete(r2Target.previousKey);
    }
    return c.json(uploadSuccess({ key: r2Key, source, target }));
  }

  // DB record: create a song_instance pointing at the uploaded file. We need
  // a master_id FK, so create a placeholder master that applyMetadataResult
  // will relink (delete + recreate under the right album/artist) once the
  // metadata worker parses the file. tag_scanned=0 so the work queue picks
  // it up and applyMetadataResult runs on submit.
  const sourceId = source === "webdav"
    ? (await db.prepare("SELECT id FROM storage_sources WHERE type = 'webdav' AND enabled = 1 LIMIT 1").first<{ id: string }>())?.id || "webdav"
    : "r2-local";
  const storageUri = source === "webdav" ? `webdav://${sourceId}/${r2Key}` : stableR2Uri((target as R2UploadTarget).objectId, suffix);
  const title = name.replace(/\.[^.]+$/, "");

  try {
    const previousEntry = source === "r2" ? (target as R2UploadTarget).previousEntry : null;
    const existing = previousEntry?.instance_id
      ? await db.prepare(
        "SELECT id, master_id FROM song_instances WHERE id = ? AND source_type = 'original' LIMIT 1",
      ).bind(previousEntry.instance_id).first<{ id: string; master_id: string }>()
      : await db.prepare(
        "SELECT id, master_id FROM song_instances WHERE storage_uri = ? AND source_type = 'original' LIMIT 1",
      ).bind(storageUri).first<{ id: string; master_id: string }>();
    if (existing) {
      await db.prepare(
        "UPDATE song_instances SET source_id = ?, storage_uri = ?, storage_object_id = ?, suffix = ?, content_type = ?, size = ?, tag_scanned = 0, missing = 0, updated_at = ? WHERE id = ?",
      ).bind(sourceId, storageUri, source === "r2" ? (target as R2UploadTarget).objectId : null, suffix, contentType, sizeHeader || 0, now, existing.id).run();
      if (source === "r2") {
        await registerR2Object(db, {
          objectId: (target as R2UploadTarget).objectId,
          physicalKey: r2Key,
          logicalPath: (target as R2UploadTarget).logicalPath,
          suffix,
          contentType,
          size: sizeHeader || 0,
          instanceId: existing.id,
        });
        await cleanupStorageObject(db, (target as R2UploadTarget).previousEntry?.object_id || null);
        if ((target as R2UploadTarget).previousKey && (target as R2UploadTarget).previousKey !== r2Key) {
          await env.MUSIC_BUCKET.delete((target as R2UploadTarget).previousKey!);
        }
      }
      return finishAudioUpload(c, env, r2Key, storageUri, existing.id, source, target);
    }

    const instanceId = `si-upload-${crypto.randomUUID().substring(0, 12)}`;
    const masterId = `sm-upload-${crypto.randomUUID().substring(0, 12)}`;
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO artists (id, name, sort_name) VALUES ('unknown-artist', 'Unknown Artist', 'unknown artist')"),
      db.prepare("INSERT OR IGNORE INTO albums (id, name, sort_name) VALUES ('pending-uploads', 'Pending Uploads', 'pending uploads')"),
      db.prepare("INSERT INTO song_masters (id, album_id, artist_id, title, created_at, updated_at) VALUES (?, 'pending-uploads', 'unknown-artist', ?, ?, ?)")
        .bind(masterId, title, now, now),
      db.prepare("INSERT INTO song_instances (id, master_id, source_id, source_type, storage_uri, storage_object_id, suffix, content_type, size, tag_scanned, created_at, updated_at) VALUES (?, ?, ?, 'original', ?, ?, ?, ?, ?, 0, ?, ?)")
        .bind(instanceId, masterId, sourceId, storageUri, source === "r2" ? (target as R2UploadTarget).objectId : null, suffix, contentType, sizeHeader || 0, now, now),
    ]);
    if (source === "r2") {
      await registerR2Object(db, {
        objectId: (target as R2UploadTarget).objectId,
        physicalKey: r2Key,
        logicalPath: (target as R2UploadTarget).logicalPath,
        suffix,
        contentType,
        size: sizeHeader || 0,
        instanceId,
      });
      await cleanupStorageObject(db, (target as R2UploadTarget).previousEntry?.object_id || null);
    }
    return finishAudioUpload(c, env, r2Key, storageUri, instanceId, source, target);
  } catch (e) {
    if (source !== "webdav") await env.MUSIC_BUCKET.delete(r2Key);
    return c.json({ ok: false, error: `DB insert failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
});

// POST /storage/files/upload-conflicts { source, files: [{ name, path }] }
// Lets the client ask about a batch before it starts sending file bytes.
filesRoutes.post("/files/upload-conflicts", permissionMiddleware("upload"), async (c) => {
  const env = c.env as Env;
  const body = await c.req.json<{ source?: string; files?: Array<{ name?: string; path?: string }> }>();
  const source = body.source || "r2";
  if (!Array.isArray(body.files) || body.files.length === 0) {
    return c.json({ ok: false, error: "files must contain at least one item" }, 400);
  }
  if (body.files.some((file) => !file.name)) {
    return c.json({ ok: false, error: "Every file needs a name" }, 400);
  }
  try {
    const items = await Promise.all(body.files.map(async (file) => {
      const path = normalizeUploadPath(file.path || "");
      if (path === null || !isSafeUploadName(file.name!)) throw new Error("Invalid upload path or name");
      const key = `music/${path ? `${path}/` : ""}${file.name}`;
      const exists = source === "r2"
        ? !!await findR2EntryByPath(env.DB, key)
        : await doesUploadTargetExist(env, source, key);
      return {
        name: file.name,
        key,
        storageUri: source === "webdav" ? `webdav://webdav/${key}` : `r2://${key}`,
        conflict: exists,
      };
    }));
    return c.json({ ok: true, source, items, conflicts: items.filter((item) => item.conflict) });
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 502);
  }
});

async function finishAudioUpload(
  c: import("hono").Context,
  env: Env,
  r2Key: string,
  storageUri: string,
  instanceId: string,
  source: string,
  target: UploadTarget,
): Promise<Response> {
  const db = env.DB;
  const suffix = r2Key.split(".").pop() || "bin";
  const sizeHeader = parseInt(c.req.header("Content-Length") || "0", 10);

  // Dispatch a metadata task so the browser worker pool parses the
  // uploaded file's tags and relinks the master to the right album/artist.
  // Best-effort: if the pool is disabled or dispatch fails, the file still
  // lives in R2 + D1; a manual scan will pick it up later.
  try {
    const poolEnabled = await getFeatureString(env, "worker_pool_enabled", "1");
    if (poolEnabled === "1") {
      await dispatchWork(db, {
        taskType: "metadata",
        payload: {
          instanceId,
          sourceUri: storageUri,
          suffix,
          size: sizeHeader || 0,
        },
        requiredCaps: ["music-metadata"],
        priority: 3, // higher than scan-dispatched tasks (5) so uploads parse fast
        dedupKey: instanceId,
      }, env);
    }
  } catch (e) {
    console.error(`[upload] dispatchWork failed for ${instanceId}:`, e);
  }

  // Optional pre-transcode: the upload UI's expandable "pre-transcode
  // options" panel lets the uploader pick which profiles to pre-bake for
  // this file, replacing the old (never-wired) global transcode_mode /
  // default_transcode_profiles settings. Comma-separated profile ids;
  // unknown ids are silently dropped. Best-effort, same as the metadata
  // dispatch above — a failure here never fails the upload itself.
  const profilesParam = c.req.query("profiles") || "";
  if (profilesParam) {
    const reqUrl = new URL(c.req.url);
    const origin = `${reqUrl.protocol}//${reqUrl.host}`;
    const requested = profilesParam.split(",").map((p) => p.trim()).filter(Boolean);
    for (const profileId of requested) {
      if (!getProfile(profileId)) continue;
      c.executionCtx.waitUntil(preBakeProfile(env, origin, instanceId, profileId));
    }
  }

  return c.json(uploadSuccess({ key: r2Key, id: instanceId, storageUri, source, target }));
}

function isContentLengthMismatch(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^Attempt to (?:write too many bytes through|close a) (?:a )?FixedLengthStream/i.test(message)
    || /^FixedLengthStream length mismatch:/i.test(message);
}

function isSafeUploadName(name: string): boolean {
  return !!name && !/[\\/\x00-\x1F\x7F]/.test(name) && name !== "." && name !== "..";
}

function normalizeUploadPath(raw: string): string | null {
  const path = raw.replace(/^music\/?/, "");
  if (!path) return "";
  if (/[\\\x00-\x1F\x7F]/.test(path)) return null;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return path;
}

async function verifyWebDavUpload(url: string, creds: { username: string; password: string }, cap: number): Promise<{ ok: true } | { ok: false; status: 413 | 502; error: string }> {
  const auth = { Authorization: `Basic ${btoa(`${creds.username}:${creds.password}`)}` };
  const head = await fetch(url, { method: "HEAD", headers: auth });
  const size = parseInt(head.headers.get("Content-Length") || "", 10);
  if (head.ok && Number.isFinite(size) && size <= cap) return { ok: true };
  try { await fetch(url, { method: "DELETE", headers: auth }); } catch { /* best-effort cleanup follows failed verification */ }
  return head.ok && Number.isFinite(size)
    ? { ok: false, status: 413, error: "Payload too large" }
    : { ok: false, status: 502, error: "WebDAV upload size could not be verified; uploaded object was removed" };
}

type UploadTarget = { key: string; policy: "error" | "overwrite" | "rename"; existed: boolean; requestedKey: string };
type R2UploadTarget = UploadTarget & {
  logicalPath: string;
  objectId: string;
  previousKey: string | null;
  previousEntry: Awaited<ReturnType<typeof findR2EntryByPath>>;
};
const MAX_RENAME_ATTEMPTS = 1000;

async function resolveR2UploadTarget(
  db: D1Database,
  requestedPath: string,
  suffix: string,
  requestedPolicy: string | undefined,
): Promise<R2UploadTarget | { error: { status: 400 | 409 | 502; body: Record<string, unknown> } }> {
  const policy = requestedPolicy === "overwrite" || requestedPolicy === "rename" ? requestedPolicy : "error";
  if (requestedPolicy && policy === "error" && requestedPolicy !== "error") {
    return { error: { status: 400, body: { ok: false, error: "Invalid conflict policy", conflict: { requestedKey: requestedPath, policies: ["error", "overwrite", "rename"] } } } };
  }
  try {
    let logicalPath = requestedPath;
    let previousEntry = await findR2EntryByPath(db, logicalPath);
    if (previousEntry?.kind === "folder") {
      return { error: { status: 409, body: { ok: false, error: "A folder already exists at the requested path" } } };
    }
    if (previousEntry && policy === "error") {
      return { error: { status: 409, body: uploadConflict("r2", requestedPath) } };
    }
    if (previousEntry && policy === "rename") {
      const dot = requestedPath.lastIndexOf(".");
      const slash = requestedPath.lastIndexOf("/");
      const base = dot > slash ? requestedPath.slice(0, dot) : requestedPath;
      const extension = base === requestedPath ? "" : requestedPath.slice(dot);
      previousEntry = null;
      for (let n = 1; n <= MAX_RENAME_ATTEMPTS; n++) {
        const candidate = `${base} (${n})${extension}`;
        const existing = await findR2EntryByPath(db, candidate);
        if (!existing) {
          logicalPath = candidate;
          break;
        }
        if (n === MAX_RENAME_ATTEMPTS) {
          return { error: { status: 409, body: { ok: false, error: "No available renamed path" } } };
        }
      }
    }
    const objectId = createStableObjectId(`${logicalPath}:${crypto.randomUUID()}`);
    const key = createStableObjectKey(objectId, suffix);
    const oldEntry = policy === "overwrite" ? await findR2EntryByPath(db, requestedPath) : null;
    return {
      key,
      objectId,
      logicalPath,
      previousKey: oldEntry?.physical_key || null,
      previousEntry: oldEntry,
      policy,
      existed: !!oldEntry,
      requestedKey: requestedPath,
    };
  } catch (error) {
    return { error: { status: 502, body: { ok: false, error: error instanceof Error ? error.message : String(error) } } };
  }
}

async function resolveUploadTarget(env: Env, source: string, requestedKey: string, requestedPolicy: string | undefined): Promise<UploadTarget | { error: { status: 400 | 409 | 502; body: Record<string, unknown> } }> {
  const policy = requestedPolicy === "overwrite" || requestedPolicy === "rename" ? requestedPolicy : "error";
  if (requestedPolicy && policy === "error" && requestedPolicy !== "error") {
    return { error: { status: 400, body: { ok: false, error: "Invalid conflict policy", conflict: { requestedKey, policies: ["error", "overwrite", "rename"] } } } };
  }
  try {
    if (!await doesUploadTargetExist(env, source, requestedKey)) return { key: requestedKey, policy, existed: false, requestedKey };
    if (policy === "overwrite") return { key: requestedKey, policy, existed: true, requestedKey };
    if (policy === "rename") {
      const dot = requestedKey.lastIndexOf(".");
      const base = dot > requestedKey.lastIndexOf("/") ? requestedKey.slice(0, dot) : requestedKey;
      const extension = base === requestedKey ? "" : requestedKey.slice(dot);
      for (let n = 1; n <= MAX_RENAME_ATTEMPTS; n++) {
        const key = `${base} (${n})${extension}`;
        if (!await doesUploadTargetExist(env, source, key)) return { key, policy, existed: true, requestedKey };
      }
      return { error: { status: 409, body: { ok: false, error: "No available renamed path", conflict: { requestedKey, policies: ["reject", "overwrite", "rename"] } } } };
    }
    return { error: { status: 409, body: uploadConflict(source, requestedKey) } };
  } catch (error) {
    return { error: { status: 502, body: { ok: false, error: error instanceof Error ? error.message : String(error) } } };
  }
}

async function doesUploadTargetExist(env: Env, source: string, key: string): Promise<boolean> {
  if (source !== "webdav") return Boolean(await env.MUSIC_BUCKET.head(key));
  const creds = await getSourceCredentials(env.DB, "webdav", env);
  if (!creds) throw new Error("No WebDAV source configured");
  const url = `${creds.baseUrl.replace(/\/$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetch(url, { method: "HEAD", headers: { Authorization: `Basic ${btoa(`${creds.username}:${creds.password}`)}` } });
  if (response.status === 404) return false;
  if (response.ok) return true;
  throw new Error(`WebDAV conflict check failed: ${response.status}`);
}

function uploadConflict(source: string, requestedKey: string): Record<string, unknown> {
  return {
    ok: false,
    error: "File already exists",
    conflict: {
      requestedKey,
      storageUri: source === "webdav" ? `webdav://webdav/${requestedKey}` : `r2://${requestedKey}`,
      policies: ["error", "overwrite", "rename"],
    },
  };
}

function uploadSuccess(input: { key: string; id?: string; storageUri?: string; source: string; target: UploadTarget }): Record<string, unknown> {
  const finalPath = "logicalPath" in input.target ? input.target.logicalPath : input.key;
  return {
    ok: true,
    key: input.key,
    id: input.id,
    storageUri: input.storageUri,
    conflict: {
      policy: input.target.policy,
      requestedKey: input.target.requestedKey,
      finalKey: finalPath,
      overwritten: input.target.existed && input.target.policy === "overwrite",
      renamed: finalPath !== input.target.requestedKey,
    },
  };
}

// Browsers leave the Content-Type empty or octet-stream for the extensions
// they don't know — .lrc and friends among them — so fall back to the suffix.
// Storing a lyric sidecar as octet-stream makes it a download rather than
// text when anything fetches it directly.
function normalizeUploadContentType(contentType: string | null | undefined, suffix: string): string {
  const lower = (contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (lower && lower !== "application/octet-stream") return contentType || lower;
  switch (suffix.toLowerCase()) {
    case "flac": return "audio/flac";
    case "mp3": return "audio/mpeg";
    case "m4a": return "audio/mp4";
    case "aac": return "audio/aac";
    case "ogg": return "audio/ogg";
    case "opus": return "audio/opus";
    case "wav": return "audio/wav";
    case "lrc":
    case "krc":
    case "elrc":
    case "txt": return "text/plain; charset=utf-8";
    case "ttml": return "application/ttml+xml";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "png": return "image/png";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "avif": return "image/avif";
    case "bmp": return "image/bmp";
    default: return contentType || "application/octet-stream";
  }
}

// ── File operations (studio-style structured REST, no notes/color-labels) ──

// POST /storage/files/mkdir body: { source: "r2" | <sourceId>, path: "music/newfolder" }
//
// Every other source is treated as WebDAV, same as files/list does for any
// non-r2 source id — MKCOL is idempotent here (405 "already exists" counts
// as success).
filesRoutes.post("/files/mkdir", permissionMiddleware("upload"), async (c) => {
  const env = c.env as Env;
  const body = await c.req.json<{ source?: string; path?: string }>();
  const source = body.source || "r2";
  const path = (body.path || "").replace(/^\/+|\/+$/g, "");
  const segments = path.split("/").filter(Boolean);
  if (!path || segments.some((seg) => seg === "." || seg === "..")) {
    return c.json({ ok: false, error: "Invalid path" }, 400);
  }

  if (source === "r2") {
    await ensureR2Folder(env.DB, path);
    return c.json({ ok: true });
  }

  const src = await env.DB.prepare(
    "SELECT id, base_url, username, password, root_path FROM storage_sources WHERE id = ? AND enabled = 1",
  ).bind(source).first<SourceRow>();
  if (!src) return c.json({ ok: false, error: "Source not found" }, 404);

  const url = `${srcBaseUrl(src)}/${encodePath(path)}/`;
  const resp = await fetch(url, {
    method: "MKCOL",
    headers: { Authorization: `Basic ${btoa(`${src.username || ""}:${src.password || ""}`)}` },
  });
  if (!resp.ok && resp.status !== 405) {
    return c.json({ ok: false, error: `MKCOL failed: HTTP ${resp.status}` }, 502);
  }
  return c.json({ ok: true });
});

// Drop a song master when its last instance is gone, then garbage-collect the
// album/artist rows nothing else references. Extracted from files/delete so
// the recursive files/deleteFolder below can cascade with the same semantics.
async function cleanupOrphanMaster(db: D1Database, masterId: string) {
  const others = await db.prepare("SELECT COUNT(*) AS n FROM song_instances WHERE master_id = ?")
    .bind(masterId).first<{ n: number }>();
  if (others?.n) return;
  const master = await db.prepare("SELECT album_id, artist_id FROM song_masters WHERE id = ?")
    .bind(masterId).first<{ album_id: string; artist_id: string }>();
  await db.prepare("DELETE FROM song_masters WHERE id = ?").bind(masterId).run();
  if (master) {
    await db.prepare("DELETE FROM albums WHERE id = ? AND NOT EXISTS (SELECT 1 FROM song_masters WHERE album_id = ?)")
      .bind(master.album_id, master.album_id).run();
    await db.prepare(`DELETE FROM artists WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM song_masters WHERE artist_id = ? OR album_artist_id = ?)
      AND NOT EXISTS (SELECT 1 FROM song_artists WHERE artist_id = ?)`)
      .bind(master.artist_id, master.artist_id, master.artist_id, master.artist_id).run();
  }
}

async function cleanupStorageObject(db: D1Database, objectId: string | null): Promise<void> {
  if (!objectId) return;
  await db.prepare(
    "DELETE FROM storage_objects WHERE id = ? AND NOT EXISTS (SELECT 1 FROM storage_entries WHERE object_id = ?)",
  ).bind(objectId, objectId).run();
}

// Normalize a user-supplied folder path: strip surrounding slashes and refuse
// empty results or "."/".." traversal segments (same policy as files/mkdir).
function normalizeFolderPath(p: string | undefined): string | null {
  const path = (p || "").replace(/^\/+|\/+$/g, "");
  if (!path) return null;
  if (path.split("/").some((seg) => !seg || seg === "." || seg === "..")) return null;
  return path;
}

// POST /rest/files/delete body: { key: "objects/obj_....mp3" }
filesRoutes.post("/files/delete", permissionMiddleware("delete"), async (c) => {
  const user = c.get("user");
  if (user.level < 2) {
    return c.json({ ok: false, error: "File deletion requires admin privileges (level 2+)" }, 403);
  }
  const env = c.env as Env;
  const body = await c.req.json<{ key: string }>();
  const { key } = body;
  if (!key) return c.json({ ok: false, error: "Missing key" }, 400);

  const db = env.DB;
  const entry = await findR2EntryByKey(db, key);
  if (!entry) return c.json({ ok: false, error: "File not found" }, 404);
  await env.MUSIC_BUCKET.delete(key);
  const inst = entry.instance_id
    ? await db.prepare("SELECT master_id FROM song_instances WHERE id = ?").bind(entry.instance_id).first<{ master_id: string }>()
    : null;
  if (entry.instance_id) await db.prepare("DELETE FROM song_instances WHERE id = ?").bind(entry.instance_id).run();
  await db.prepare("DELETE FROM storage_entries WHERE id = ?").bind(entry.id).run();
  if (entry.object_id) await db.prepare("DELETE FROM storage_objects WHERE id = ?").bind(entry.object_id).run();
  if (inst) await cleanupOrphanMaster(db, inst.master_id);
  return c.json({ ok: true });
});

// POST /storage/files/deleteFolder body: { path: "music/folder" } — R2 only,
// on the R2 source). The R2 objects are resolved from D1 entries, so a folder
// delete removes only objects that belong to its logical subtree.
filesRoutes.post("/files/deleteFolder", permissionMiddleware("delete"), async (c) => {
  const env = c.env as Env;
  const body = await c.req.json<{ path?: string }>();
  const path = normalizeFolderPath(body.path);
  if (!path) return c.json({ ok: false, error: "Invalid path" }, 400);

  const db = env.DB;
  const folder = await findR2EntryByPath(db, path);
  if (!folder || folder.kind !== "folder") return c.json({ ok: false, error: "Folder not found" }, 404);
  const escapedPrefix = `${path.replace(/[\\%_]/g, (ch) => `\\${ch}`)}/%`;
  const rows = await db.prepare(
    `SELECT e.id, e.object_id, e.instance_id, o.physical_key
       FROM storage_entries e
       LEFT JOIN storage_objects o ON o.id = e.object_id
      WHERE e.source_id = ? AND (e.path = ? OR e.path LIKE ? ESCAPE '\\')`
  ).bind(R2_SOURCE_ID, path, escapedPrefix).all<{ id: string; object_id: string | null; instance_id: string | null; physical_key: string | null }>();
  const keys = rows.results.map((row) => row.physical_key).filter((key): key is string => !!key);
  for (let i = 0; i < keys.length; i += 1000) await env.MUSIC_BUCKET.delete(keys.slice(i, i + 1000));
  const affected = new Set<string>();
  for (const row of rows.results) {
    if (row.instance_id) {
      const inst = await db.prepare("SELECT master_id FROM song_instances WHERE id = ?").bind(row.instance_id).first<{ master_id: string }>();
      if (inst) affected.add(inst.master_id);
      await db.prepare("DELETE FROM song_instances WHERE id = ?").bind(row.instance_id).run();
    }
    await db.prepare("DELETE FROM storage_entries WHERE id = ?").bind(row.id).run();
    if (row.object_id) await db.prepare("DELETE FROM storage_objects WHERE id = ?").bind(row.object_id).run();
  }
  for (const masterId of affected) await cleanupOrphanMaster(db, masterId);
  return c.json({ ok: true, deleted: rows.results.length });
});

// POST /storage/files/moveFolder body: { path: "music/a", dest: "music/b/a" }
// — R2 only. A folder move updates D1 paths and parent ids; R2 bytes stay at
// their immutable object keys, so the operation is a single database change.
filesRoutes.post("/files/moveFolder", permissionMiddleware("upload"), async (c) => {
  const env = c.env as Env;
  const body = await c.req.json<{ path?: string; dest?: string }>();
  const path = normalizeFolderPath(body.path);
  const dest = normalizeFolderPath(body.dest);
  if (!path || !dest) return c.json({ ok: false, error: "Invalid path or dest" }, 400);
  if (dest === path || dest.startsWith(`${path}/`)) {
    return c.json({ ok: false, error: "Cannot move a folder into itself" }, 400);
  }

  const db = env.DB;
  const folder = await findR2EntryByPath(db, path);
  if (!folder || folder.kind !== "folder") return c.json({ ok: false, error: "Folder not found" }, 404);
  if (await findR2EntryByPath(db, dest)) return c.json({ ok: false, error: "Destination already exists" }, 409);
  const { parentPath } = splitEntryPath(dest);
  const destParentId = await ensureR2Folder(db, parentPath);
  const now = Math.floor(Date.now() / 1000);
  const oldPrefix = `${path}/`;
  const escapedOldPrefix = `${path.replace(/[\\%_]/g, (ch) => `\\${ch}`)}/%`;
  const rows = await db.prepare(
    "SELECT id, path FROM storage_entries WHERE source_id = ? AND (id = ? OR path LIKE ? ESCAPE '\\') ORDER BY length(path) ASC",
  ).bind(R2_SOURCE_ID, folder.id, escapedOldPrefix).all<{ id: string; path: string }>();
  const updates = rows.results.map((row) => {
    const suffix = row.path === path ? "" : row.path.slice(oldPrefix.length);
    const nextPath = suffix ? `${dest}/${suffix}` : dest;
    const slash = nextPath.lastIndexOf("/");
    const parentId = row.id === folder.id ? destParentId : null;
    return { row, nextPath, name: slash < 0 ? nextPath : nextPath.slice(slash + 1), parentId };
  });
  const parentIds = new Map<string, string | null>();
  const nextByPath = new Map(updates.map((item) => [item.nextPath, item.row.id]));
  for (const item of updates) {
    if (item.row.id === folder.id) parentIds.set(item.row.id, destParentId);
    else {
      const parentPath = item.nextPath.slice(0, item.nextPath.lastIndexOf("/"));
      const movedParentId = nextByPath.get(parentPath);
      if (movedParentId) parentIds.set(item.row.id, movedParentId);
      else {
        const parent = await findR2EntryByPath(db, parentPath);
        parentIds.set(item.row.id, parent?.id || null);
      }
    }
  }
  for (const item of updates) {
    await db.prepare(
      "UPDATE storage_entries SET parent_id = ?, path = ?, display_name = ?, updated_at = ? WHERE id = ?",
    ).bind(parentIds.get(item.row.id) ?? item.parentId, item.nextPath, item.name, now, item.row.id).run();
  }
  return c.json({ ok: true, moved: updates.length });
});

// POST /rest/files/move body: { key: stable physical key, dest: logical path }
filesRoutes.post("/files/move", permissionMiddleware("upload"), async (c) => {
  const env = c.env as Env;
  const body = await c.req.json<{ key: string; dest: string }>();
  const { key, dest } = body;
  if (!key || !dest) return c.json({ ok: false, error: "Missing key or dest" }, 400);
  const entry = await findR2EntryByKey(env.DB, key);
  if (!entry || entry.kind !== "file") return c.json({ ok: false, error: "Source not found" }, 404);
  const logicalDest = normalizeFolderPath(dest);
  if (!logicalDest) return c.json({ ok: false, error: "Invalid destination" }, 400);
  if (logicalDest === entry.path) return c.json({ ok: true });
  if (await findR2EntryByPath(env.DB, logicalDest)) return c.json({ ok: false, error: "Destination already exists" }, 409);
  const { parentPath } = splitEntryPath(logicalDest);
  const parentId = await ensureR2Folder(env.DB, parentPath);
  const slash = logicalDest.lastIndexOf("/");
  await env.DB.prepare(
    "UPDATE storage_entries SET parent_id = ?, path = ?, display_name = ?, updated_at = ? WHERE id = ?",
  ).bind(parentId, logicalDest, slash < 0 ? logicalDest : logicalDest.slice(slash + 1), Math.floor(Date.now() / 1000), entry.id).run();
  return c.json({ ok: true });
});

// POST /rest/files/copy body: { key: stable physical key, dest: logical path }
filesRoutes.post("/files/copy", permissionMiddleware("upload"), async (c) => {
  const env = c.env as Env;
  const body = await c.req.json<{ key: string; dest: string }>();
  const { key, dest } = body;
  if (!key || !dest) return c.json({ ok: false, error: "Missing key or dest" }, 400);

  const source = await findR2EntryByKey(env.DB, key);
  const logicalDest = normalizeFolderPath(dest);
  if (!source || source.kind !== "file" || !logicalDest) {
    return c.json({ ok: false, error: "Source not found" }, 404);
  }
  if (await findR2EntryByPath(env.DB, logicalDest)) return c.json({ ok: false, error: "Destination already exists" }, 409);
  const sourceObject = source.object_id
    ? await env.DB.prepare("SELECT suffix, content_type, size FROM storage_objects WHERE id = ?")
      .bind(source.object_id).first<{ suffix: string; content_type: string | null; size: number }>()
    : null;
  if (!sourceObject) return c.json({ ok: false, error: "Source object metadata not found" }, 404);
  const objectId = createStableObjectId(`${logicalDest}:${crypto.randomUUID()}`);
  const destKey = createStableObjectKey(objectId, sourceObject.suffix);
  if (!await copyR2Object(env, key, destKey)) return c.json({ ok: false, error: "Source not found" }, 404);
  await registerR2Object(env.DB, {
    objectId,
    physicalKey: destKey,
    logicalPath: logicalDest,
    suffix: sourceObject.suffix,
    contentType: sourceObject.content_type,
    size: sourceObject.size,
  });
  return c.json({ ok: true });
});

// Cross-source file copy (byte-level copy between any two adapters).
//
// POST /rest/files/crossCopy body: { srcUri, destSource, destPath }
//
//   srcUri   — Full storage URI of the source file:
//                r2://music/album/track.mp3
//                webdav://<sourceId>/path/track.mp3
//                url://https://...
//                subsonic://<sourceId>/rest/stream?id=...
//
// destSource — 'r2' for the local R2 bucket, OR a storage_sources.id for
//              a remote source. Only r2 and webdav sources are writable;
//              url and subsonic always return an error.
//
//   destPath — Relative path at the destination (e.g. "Music/album/track.mp3").
//              For R2 destinations `music/` is prepended automatically if not
//              already present. For WebDAV the path is relative to the
//              source's root (as stored in the adapter credentials).
//
// Optional `registerInstance` body field (mirror-to-R2 flow): when
// present, the endpoint also INSERTs a song_instances row for the new R2
// copy so /rest/stream can select it without waiting for a re-scan.
// Shape: { masterId, suffix, contentType, size, sourceInstanceId }.
// The new instance id is `si-mirror-<rand16>` to distinguish from upload
// and transcode flow ids. The source_type is 'original' (it's a lossless
// copy of the original file, not a transcode).
//
// Response: { ok: true, destUri, instanceId? } or { ok: false, error: "..." }
filesRoutes.post("/files/crossCopy", permissionMiddleware("upload"), async (c) => {
  const env = c.env as Env;
  const body = await c.req.json<{
    srcUri?: string;
    destSource?: string;
    destPath?: string;
    registerInstance?: {
      masterId: string;
      suffix: string;
      contentType: string;
      size: number;
      sourceInstanceId: string;
    };
  }>();
  const { srcUri, destSource, destPath, registerInstance } = body;

  if (!srcUri || !destSource || !destPath) {
    return c.json({ ok: false, error: "Missing srcUri, destSource, or destPath" }, 400);
  }

  // ── 1. Resolve source read adapter ──────────────────────────────────────
  const colonIdx = srcUri.indexOf("://");
  if (colonIdx < 0) return c.json({ ok: false, error: "Invalid srcUri: missing scheme" }, 400);
  const srcScheme = srcUri.substring(0, colonIdx) as "r2" | "url" | "webdav" | "subsonic";

  let srcStream: { body: ReadableStream<Uint8Array> | null; statusCode: number; contentType: string };
  switch (srcScheme) {
    case "r2":
      srcStream = await createR2Adapter(env.MUSIC_BUCKET).stream(srcUri);
      break;
    case "webdav":
      srcStream = await createWebDAVAdapter(env.DB, env).stream(srcUri);
      break;
    case "url":
      srcStream = await urlAdapter.stream(srcUri);
      break;
    case "subsonic":
      srcStream = await createSubsonicAdapter(env.DB, {}, env).stream(srcUri);
      break;
    default:
      return c.json({ ok: false, error: `Unknown source scheme: ${srcScheme}` }, 400);
  }

  if (!srcStream.body || srcStream.statusCode >= 400) {
    return c.json({ ok: false, error: `Source stream failed with status ${srcStream.statusCode}` }, 502);
  }

  // ── 2. Resolve destination adapter + URI ────────────────────────────────
  let destUri: string;
  let destPut: ((uri: string, body: ReadableStream<Uint8Array>, contentType?: string) => Promise<void>) | null = null;
  let r2Destination: { objectId: string; key: string; logicalPath: string; suffix: string } | null = null;

  if (destSource === "r2") {
    // Strip leading 'music/' to normalize the logical D1 path, then allocate
    // an immutable R2 object key.
    const cleanPath = destPath.replace(/^music\/?/, "");
    const logicalPath = "music/" + cleanPath;
    const suffix = logicalPath.split(".").pop() || "bin";
    const objectId = createStableObjectId(`${logicalPath}:${crypto.randomUUID()}`);
    const key = createStableObjectKey(objectId, suffix);
    r2Destination = { objectId, key, logicalPath, suffix };
    destUri = `r2://${key}`;
    const adapter = createR2Adapter(env.MUSIC_BUCKET);
    destPut = adapter.put!.bind(adapter);
  } else {
    // destSource is a storage_sources.id
    const row = await env.DB.prepare(
      "SELECT id, type FROM storage_sources WHERE id = ? AND enabled = 1",
    ).bind(destSource).first<{ id: string; type: string }>();

    if (!row) {
      return c.json({ ok: false, error: `Destination source not found or disabled: ${destSource}` }, 404);
    }

    switch (row.type) {
      case "r2": {
        const logicalPath = "music/" + destPath.replace(/^music\/?/, "");
        const suffix = logicalPath.split(".").pop() || "bin";
        const objectId = createStableObjectId(`${logicalPath}:${crypto.randomUUID()}`);
        const key = createStableObjectKey(objectId, suffix);
        r2Destination = { objectId, key, logicalPath, suffix };
        destUri = `r2://${key}`;
        const adapter = createR2Adapter(env.MUSIC_BUCKET);
        destPut = adapter.put!.bind(adapter);
        break;
      }
      case "webdav": {
        destUri = `webdav://${row.id}/${destPath}`;
        const wdAdapter = createWebDAVAdapter(env.DB, env);
        destPut = wdAdapter.put!.bind(wdAdapter);
        break;
      }
      case "url":
        return c.json({ ok: false, error: "Destination source is read-only (url)" }, 400);
      case "subsonic":
        return c.json({ ok: false, error: "Destination source is read-only (subsonic)" }, 400);
      default:
        return c.json({ ok: false, error: `Unknown destination source type: ${row.type}` }, 400);
    }
  }

  // ── 3. Write bytes ───────────────────────────────────────────────────────
  try {
    await destPut(destUri, srcStream.body as ReadableStream<Uint8Array>, srcStream.contentType);
  } catch (e) {
    return c.json(
      { ok: false, error: `Write to destination failed: ${e instanceof Error ? e.message : String(e)}` },
      500,
    );
  }

  // ── 4. Optional song_instance registration for mirrored objects ─────────
  // When the caller provides registerInstance, create a song_instances row
  // pointing at the new R2 copy so /rest/stream can select it immediately.
  let instanceId: string | undefined;
  if (r2Destination) {
    try {
      if (registerInstance) {
        const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
        instanceId = `si-mirror-${rand}`;
      }
      const now = Math.floor(Date.now() / 1000);
      // Copy physical params from the source instance so the stream selector
      // has bit_rate/duration/etc. without re-parsing.
      const sourceRow = registerInstance ? await env.DB.prepare(
        "SELECT bit_rate, sample_rate, bit_depth, channels, duration, size, content_type, suffix, transcode_profile FROM song_instances WHERE id = ?",
      ).bind(registerInstance.sourceInstanceId).first<{
        bit_rate: number | null; sample_rate: number | null; bit_depth: number | null;
        channels: number | null; duration: number | null; size: number | null;
        content_type: string | null; suffix: string | null; transcode_profile: string | null;
      }>() : null;
      if (registerInstance) await env.DB.prepare(
        `INSERT INTO song_instances
           (id, master_id, source_id, source_type, parent_instance_id,
            storage_uri, storage_object_id, transcode_profile, suffix, content_type,
            bit_rate, sample_rate, bit_depth, channels, duration, size,
            tag_scanned, created_at, updated_at)
         VALUES (?, ?, 'r2-local', 'original', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(
        instanceId,
        registerInstance.masterId,
        registerInstance.sourceInstanceId,
        destUri,
        r2Destination.objectId,
        sourceRow?.suffix || registerInstance.suffix,
        sourceRow?.content_type || registerInstance.contentType,
        sourceRow?.bit_rate ?? null,
        sourceRow?.sample_rate ?? null,
        sourceRow?.bit_depth ?? null,
        sourceRow?.channels ?? null,
        sourceRow?.duration ?? null,
        sourceRow?.size ?? registerInstance.size,
        now,
        now,
      ).run();
      await registerR2Object(env.DB, {
        objectId: r2Destination.objectId,
        physicalKey: r2Destination.key,
        logicalPath: r2Destination.logicalPath,
        suffix: sourceRow?.suffix || r2Destination.suffix,
        contentType: sourceRow?.content_type || registerInstance?.contentType || null,
        size: sourceRow?.size ?? registerInstance?.size ?? null,
        instanceId: instanceId || null,
      });
    } catch (e) {
      console.error(`[crossCopy] instance registration failed:`, e);
      instanceId = undefined;
    }
  }

  return c.json({ ok: true, destUri, ...(instanceId ? { instanceId } : {}) });
});

// part of the Subsonic protocol surface at /rest/*; storage/files.ts owns the
// non-Subsonic R2 / WebDAV management endpoints only).
