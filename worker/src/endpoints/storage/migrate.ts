// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One-time migration of legacy music/<logical path> R2 keys into immutable
// objects/<object id>.<suffix> keys. The endpoint is deliberately bounded;
// callers continue with the returned cursor after reviewing the result.

import { Hono } from "hono";
import { permissionMiddleware } from "../../auth";
import { createStableObjectId, createStableObjectKey, normalizeSuffix } from "../../utils/storageObjects";
import { ensureR2Folder, registerR2Object, R2_SOURCE_ID } from "../../utils/storageResolver";

export const migrationRoutes = new Hono<{ Bindings: Env }>();

const MAX_BATCH = 40;

migrationRoutes.post("/files/migrate-r2", permissionMiddleware("manage_files"), async (c) => {
  const env = c.env as Env;
  const body: { cursor?: string; limit?: number; deleteLegacy?: boolean } =
    await c.req.json<{ cursor?: string; limit?: number; deleteLegacy?: boolean }>().catch(() => ({}));
  const limit = Math.min(Math.max(Number(body.limit) || MAX_BATCH, 1), MAX_BATCH);
  const deleteLegacy = body.deleteLegacy === true;
  const listing = await env.MUSIC_BUCKET.list({ prefix: "music/", limit, ...(body.cursor ? { cursor: body.cursor } : {}) });
  let processed = 0;
  let copied = 0;
  let skipped = 0;
  let deleted = 0;
  const errors: Array<{ key: string; error: string }> = [];

  for (const object of listing.objects) {
    processed++;
    if (object.key.endsWith("/.keep")) {
      const folderPath = object.key.slice("music/".length, -"/.keep".length);
      if (folderPath) await ensureR2Folder(env.DB, `music/${folderPath}`);
      if (deleteLegacy) {
        await env.MUSIC_BUCKET.delete(object.key);
        deleted++;
      }
      skipped++;
      continue;
    }

    try {
      const suffix = normalizeSuffix(object.key.split(".").pop() || "bin");
      const objectId = createStableObjectId(`legacy:${object.key}`);
      const stableKey = createStableObjectKey(objectId, suffix);
      const known = await env.DB.prepare(
        "SELECT id, physical_key FROM storage_objects WHERE legacy_key = ? LIMIT 1",
      ).bind(object.key).first<{ id: string; physical_key: string }>();
      const targetKey = known?.physical_key || stableKey;
      const existing = await env.MUSIC_BUCKET.head(targetKey);
      if (!existing) {
        const source = await env.MUSIC_BUCKET.get(object.key);
        if (!source?.body) throw new Error("legacy object not found");
        await env.MUSIC_BUCKET.put(targetKey, source.body.pipeThrough(new FixedLengthStream(object.size)), {
          httpMetadata: source.httpMetadata,
          customMetadata: source.customMetadata,
        });
        copied++;
      } else if (existing.size !== object.size) {
        throw new Error(`target size mismatch: ${existing.size} != ${object.size}`);
      } else {
        skipped++;
      }

      const oldUri = `r2://${object.key}`;
      const instance = await env.DB.prepare(
        "SELECT id FROM song_instances WHERE storage_uri = ? AND source_id = ? LIMIT 1",
      ).bind(oldUri, R2_SOURCE_ID).first<{ id: string }>();
      await registerR2Object(env.DB, {
        objectId: known?.id || objectId,
        physicalKey: targetKey,
        legacyKey: object.key,
        logicalPath: object.key,
        suffix,
        contentType: object.httpMetadata?.contentType || null,
        size: object.size,
        etag: object.etag || null,
        lastModified: object.uploaded ? Math.floor(object.uploaded.getTime() / 1000) : null,
        instanceId: instance?.id || null,
      });
      if (instance) {
        await env.DB.prepare(
          "UPDATE song_instances SET storage_uri = ?, storage_object_id = ?, suffix = ?, content_type = ?, size = ?, missing = 0, updated_at = ? WHERE id = ?",
        ).bind(`r2://${targetKey}`, known?.id || objectId, suffix, object.httpMetadata?.contentType || null, object.size, Math.floor(Date.now() / 1000), instance.id).run();
      }
      if (deleteLegacy && targetKey !== object.key) {
        await env.MUSIC_BUCKET.delete(object.key);
        deleted++;
      }
    } catch (error) {
      errors.push({ key: object.key, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return c.json({
    ok: errors.length === 0,
    processed,
    copied,
    skipped,
    deleted,
    errors,
    nextCursor: listing.truncated ? listing.cursor : null,
    complete: !listing.truncated,
    deleteLegacy,
  }, errors.length === 0 ? 200 : 207);
});
