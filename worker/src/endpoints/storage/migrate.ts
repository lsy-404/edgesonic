// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One-time migration of legacy R2 audio objects into immutable
// objects/<object id>.<suffix> keys. Candidates come from D1 rather than an
// R2 prefix so pre-refactor root-directory objects are included without
// treating cache, cover, or unrelated bucket content as music.

import { Hono } from "hono";
import { permissionMiddleware } from "../../auth";
import { createStableObjectId, createStableObjectKey, normalizeSuffix } from "../../utils/storageObjects";
import { registerR2Object, R2_SOURCE_ID, r2KeyFromUri, stableR2Uri } from "../../utils/storageResolver";

export const migrationRoutes = new Hono<{ Bindings: Env }>();

const MAX_BATCH = 40;
const COPY_CONCURRENCY = 2;
const CLEANUP_CONCURRENCY = 4;

type Phase = "instances" | "cleanup";
type Cursor = { phase: Phase; after: string };

type MigrationOutcome = {
  copied: number;
  indexed: number;
  skipped: number;
  deleted: number;
  error?: { key: string; error: string };
};

type MigrationSummary = {
  copied: number;
  indexed: number;
  skipped: number;
  deleted: number;
  errors: Array<{ key: string; error: string }>;
};

type InstanceCandidate = {
  id: string;
  storage_uri: string;
  suffix: string;
  content_type: string | null;
};

type CleanupCandidate = {
  id: string;
  physical_key: string;
  legacy_key: string;
};

migrationRoutes.post("/files/migrate-r2", permissionMiddleware("manage_files"), async (c) => {
  const env = c.env as Env;
  const body: { cursor?: string; limit?: number; deleteLegacy?: boolean } =
    await c.req.json<{ cursor?: string; limit?: number; deleteLegacy?: boolean }>().catch(() => ({}));
  const limit = Math.min(Math.max(Number(body.limit) || MAX_BATCH, 1), MAX_BATCH);
  const deleteLegacy = body.deleteLegacy === true;
  const cursor = decodeCursor(body.cursor);

  const selection = cursor.phase === "instances"
    ? await env.DB.prepare(
      `SELECT id, storage_uri, suffix, content_type
       FROM song_instances
       WHERE source_id = ?
         AND source_type = 'original'
         AND missing = 0
         AND storage_object_id IS NULL
         AND storage_uri LIKE 'r2://%'
         AND storage_uri NOT LIKE 'r2://objects/%'
         AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
    ).bind(R2_SOURCE_ID, cursor.after, limit).all<InstanceCandidate>()
    : await env.DB.prepare(
      `SELECT id, physical_key, legacy_key
       FROM storage_objects
       WHERE legacy_key IS NOT NULL
         AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
    ).bind(cursor.after, limit).all<CleanupCandidate>();

  const outcomes = cursor.phase === "instances"
    ? await runWithConcurrency(
      selection.results as InstanceCandidate[],
      COPY_CONCURRENCY,
      (candidate) => migrateInstance(env, candidate),
    )
    : await runWithConcurrency(
      selection.results as CleanupCandidate[],
      CLEANUP_CONCURRENCY,
      (candidate) => cleanupLegacyObject(env, candidate, deleteLegacy),
    );

  const summary = outcomes.reduce<MigrationSummary>(
    (result, outcome) => ({
      copied: result.copied + outcome.copied,
      indexed: result.indexed + outcome.indexed,
      skipped: result.skipped + outcome.skipped,
      deleted: result.deleted + outcome.deleted,
      errors: outcome.error ? [...result.errors, outcome.error] : result.errors,
    }),
    { copied: 0, indexed: 0, skipped: 0, deleted: 0, errors: [] as Array<{ key: string; error: string }> },
  );

  const last = selection.results.at(-1);
  const hasMoreInPhase = selection.results.length === limit && last;
  const next = hasMoreInPhase
    ? encodeCursor({ phase: cursor.phase, after: last.id })
    : cursor.phase === "instances"
      ? encodeCursor({ phase: "cleanup", after: "" })
      : null;

  return c.json({
    ok: summary.errors.length === 0,
    phase: cursor.phase,
    processed: outcomes.length,
    ...summary,
    nextCursor: next,
    complete: next === null,
    deleteLegacy,
  }, summary.errors.length === 0 ? 200 : 207);
});

function decodeCursor(raw: string | undefined): Cursor {
  if (!raw) return { phase: "instances", after: "" };
  try {
    const parsed = JSON.parse(atob(raw)) as Partial<Cursor>;
    if ((parsed.phase === "instances" || parsed.phase === "cleanup") && typeof parsed.after === "string") {
      return { phase: parsed.phase, after: parsed.after };
    }
  } catch {
    // A legacy R2-list cursor belongs to the retired prefix-only traversal.
  }
  return { phase: "instances", after: "" };
}

function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify(cursor));
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<MigrationOutcome>): Promise<MigrationOutcome[]> {
  const results: MigrationOutcome[] = [];
  let next = 0;
  async function consume(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => consume()));
  return results;
}

async function migrateInstance(env: Env, instance: InstanceCandidate): Promise<MigrationOutcome> {
  try {
    const legacyKey = r2KeyFromUri(instance.storage_uri);
    const suffix = normalizeSuffix(instance.suffix || legacyKey.split(".").pop() || "bin");
    const source = await env.MUSIC_BUCKET.head(legacyKey);
    if (!source) throw new Error("legacy object not found");

    const known = await env.DB.prepare(
      "SELECT id, physical_key FROM storage_objects WHERE legacy_key = ? LIMIT 1",
    ).bind(legacyKey).first<{ id: string; physical_key: string }>();
    const objectId = known?.id || createStableObjectId(`legacy:${legacyKey}`);
    const physicalKey = known?.physical_key || createStableObjectKey(objectId, suffix);
    let target = await env.MUSIC_BUCKET.head(physicalKey);
    let copied = 0;

    if (!target) {
      const body = await env.MUSIC_BUCKET.get(legacyKey);
      if (!body?.body) throw new Error("legacy object not found");
      const written = await env.MUSIC_BUCKET.put(physicalKey, body.body.pipeThrough(new FixedLengthStream(source.size)), {
        httpMetadata: body.httpMetadata,
        customMetadata: body.customMetadata,
      });
      if (written.size !== source.size) throw new Error(`target size mismatch: ${written.size} != ${source.size}`);
      target = await env.MUSIC_BUCKET.head(physicalKey);
      copied = 1;
    }
    if (!target || target.size !== source.size) throw new Error(`target size mismatch: ${target?.size ?? "missing"} != ${source.size}`);

    await registerR2Object(env.DB, {
      objectId,
      physicalKey,
      legacyKey,
      logicalPath: legacyKey,
      suffix,
      contentType: source.httpMetadata?.contentType || instance.content_type,
      size: source.size,
      etag: source.etag || null,
      lastModified: source.uploaded ? Math.floor(source.uploaded.getTime() / 1000) : null,
      instanceId: instance.id,
    });
    const updated = await env.DB.prepare(
      `UPDATE song_instances
       SET storage_uri = ?, storage_object_id = ?, suffix = ?, content_type = COALESCE(?, content_type),
           size = ?, missing = 0, updated_at = ?
       WHERE source_id = ? AND storage_uri = ?`,
    ).bind(
      stableR2Uri(objectId, suffix), objectId, suffix, source.httpMetadata?.contentType || instance.content_type,
      source.size, Math.floor(Date.now() / 1000), R2_SOURCE_ID, instance.storage_uri,
    ).run();
    return { copied, indexed: updated.meta.changes, skipped: 0, deleted: 0 };
  } catch (error) {
    return { copied: 0, indexed: 0, skipped: 0, deleted: 0, error: { key: instance.storage_uri, error: error instanceof Error ? error.message : String(error) } };
  }
}

async function cleanupLegacyObject(env: Env, object: CleanupCandidate, deleteLegacy: boolean): Promise<MigrationOutcome> {
  try {
    if (!deleteLegacy) return { copied: 0, indexed: 0, skipped: 1, deleted: 0 };
    if (object.legacy_key === object.physical_key) return { copied: 0, indexed: 0, skipped: 1, deleted: 0 };
    const legacy = await env.MUSIC_BUCKET.head(object.legacy_key);
    if (!legacy) return { copied: 0, indexed: 0, skipped: 1, deleted: 0 };
    const stable = await env.MUSIC_BUCKET.head(object.physical_key);
    if (!stable || stable.size !== legacy.size) {
      throw new Error(`stable object verification failed: ${stable?.size ?? "missing"} != ${legacy.size}`);
    }
    await env.MUSIC_BUCKET.delete(object.legacy_key);
    await env.DB.prepare(
      "UPDATE storage_objects SET legacy_key = NULL, updated_at = ? WHERE id = ? AND physical_key = ?",
    ).bind(Math.floor(Date.now() / 1000), object.id, object.physical_key).run();
    return { copied: 0, indexed: 0, skipped: 0, deleted: 1 };
  } catch (error) {
    return { copied: 0, indexed: 0, skipped: 0, deleted: 0, error: { key: object.legacy_key, error: error instanceof Error ? error.message : String(error) } };
  }
}
