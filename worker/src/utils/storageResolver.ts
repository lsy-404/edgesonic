// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

import { createStableObjectId, createStableObjectKey, normalizeSuffix } from "./storageObjects";

export const R2_SOURCE_ID = "r2-local";

export interface R2StorageObjectRow {
  id: string;
  physical_key: string;
  legacy_key: string | null;
  suffix: string;
  content_type: string | null;
  size: number | null;
  etag: string | null;
  last_modified: number | null;
}

export interface R2StorageEntryRow {
  id: string;
  source_id: string;
  parent_id: string | null;
  path: string;
  display_name: string;
  kind: "file" | "folder";
  object_id: string | null;
  instance_id: string | null;
  companion_of: string | null;
}

export interface R2EntryWithObject extends R2StorageEntryRow {
  physical_key: string | null;
  object_suffix: string | null;
  object_content_type: string | null;
  object_size: number | null;
}

export function normalizeR2LogicalPath(value: string): string {
  const path = value.replace(/^\/+|\/+$/g, "");
  if (!path || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Invalid logical path");
  }
  return path;
}

export function splitR2LogicalPath(path: string): { parentPath: string; displayName: string } {
  const normalized = normalizeR2LogicalPath(path);
  const slash = normalized.lastIndexOf("/");
  return slash < 0
    ? { parentPath: "", displayName: normalized }
    : { parentPath: normalized.slice(0, slash), displayName: normalized.slice(slash + 1) };
}

export function stableR2Uri(objectId: string, suffix: string): string {
  return `r2://${createStableObjectKey(objectId, suffix)}`;
}

export function r2KeyFromUri(uri: string): string {
  if (!uri.startsWith("r2://")) throw new Error("Expected an R2 storage URI");
  const key = uri.slice("r2://".length);
  if (!key || key.includes("..")) throw new Error("Invalid R2 storage URI");
  return key;
}

async function ensureR2Source(db: D1Database, now: number): Promise<void> {
  await db.prepare(
    `INSERT INTO storage_sources
       (id, type, name, base_url, root_path, mode, enabled, created_at, updated_at)
     VALUES (?, 'r2', 'R2', '', '', 'library', 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = 1`,
  ).bind(R2_SOURCE_ID, now, now).run();
}

export async function findR2EntryByKey(db: D1Database, physicalKey: string): Promise<R2EntryWithObject | null> {
  return db.prepare(
    `SELECT e.id, e.source_id, e.parent_id, e.path, e.display_name, e.kind,
            e.object_id, e.instance_id, e.companion_of,
            o.physical_key, o.suffix AS object_suffix,
            o.content_type AS object_content_type, o.size AS object_size
       FROM storage_entries e
       JOIN storage_objects o ON o.id = e.object_id
      WHERE e.source_id = ? AND o.physical_key = ?
      LIMIT 1`,
  ).bind(R2_SOURCE_ID, physicalKey).first<R2EntryWithObject>();
}

export async function getR2EntryByUri(db: D1Database, uri: string): Promise<R2EntryWithObject | null> {
  return findR2EntryByKey(db, r2KeyFromUri(uri));
}

export const findR2EntryByUri = getR2EntryByUri;

export async function ensureR2Folder(db: D1Database, folderPath: string, now = Math.floor(Date.now() / 1000)): Promise<string | null> {
  const normalized = folderPath ? normalizeR2LogicalPath(folderPath) : "";
  if (!normalized) return null;
  await ensureR2Source(db, now);
  let parentId: string | null = null;
  let currentPath = "";
  for (const name of normalized.split("/")) {
    currentPath = currentPath ? `${currentPath}/${name}` : name;
    const existing = await db.prepare(
      "SELECT id FROM storage_entries WHERE source_id = ? AND kind = 'folder' AND path = ?",
    ).bind(R2_SOURCE_ID, currentPath).first<{ id: string }>();
    if (existing) {
      parentId = existing.id;
      continue;
    }
    const id = `se-${crypto.randomUUID().replace(/-/g, "")}`;
    await db.prepare(
      `INSERT INTO storage_entries
         (id, source_id, parent_id, path, display_name, kind, object_id, instance_id, companion_of, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'folder', NULL, NULL, NULL, ?, ?)
       ON CONFLICT(source_id, path) DO NOTHING`
    ).bind(id, R2_SOURCE_ID, parentId, currentPath, name, now, now).run();
    parentId = (await db.prepare(
      "SELECT id FROM storage_entries WHERE source_id = ? AND kind = 'folder' AND path = ?",
    ).bind(R2_SOURCE_ID, currentPath).first<{ id: string }>())?.id || id;
  }
  return parentId;
}

export async function registerR2Object(
  db: D1Database,
  input: {
    physicalKey?: string;
    objectId?: string;
    legacyKey?: string | null;
    logicalPath: string;
    suffix: string;
    contentType?: string | null;
    size?: number | null;
    etag?: string | null;
    lastModified?: number | null;
    instanceId?: string | null;
    companionOf?: string | null;
    now?: number;
  },
): Promise<{ objectId: string; physicalKey: string; entryId: string }> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const suffix = normalizeSuffix(input.suffix);
  const objectId = input.objectId || createStableObjectId(`${input.legacyKey || "new"}:${crypto.randomUUID()}`);
  const physicalKey = input.physicalKey || createStableObjectKey(objectId, suffix);
  const { parentPath, displayName } = splitR2LogicalPath(input.logicalPath);
  await ensureR2Source(db, now);
  const parentId = await ensureR2Folder(db, parentPath, now);

  await db.prepare(
    `INSERT INTO storage_objects
       (id, physical_key, legacy_key, suffix, content_type, size, etag, last_modified, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       physical_key = excluded.physical_key,
       legacy_key = COALESCE(excluded.legacy_key, storage_objects.legacy_key),
       suffix = excluded.suffix,
       content_type = COALESCE(excluded.content_type, storage_objects.content_type),
       size = COALESCE(excluded.size, storage_objects.size),
       etag = COALESCE(excluded.etag, storage_objects.etag),
       last_modified = COALESCE(excluded.last_modified, storage_objects.last_modified),
       updated_at = excluded.updated_at`,
  ).bind(
    objectId, physicalKey, input.legacyKey ?? null, suffix, input.contentType ?? null,
    input.size ?? null, input.etag ?? null, input.lastModified ?? null, now, now,
  ).run();

  const existing = await db.prepare(
    "SELECT id FROM storage_entries WHERE source_id = ? AND path = ?",
  ).bind(R2_SOURCE_ID, input.logicalPath).first<{ id: string }>();
  const entryId = existing?.id || `se-${crypto.randomUUID().replace(/-/g, "")}`;
  await db.prepare(
    `INSERT INTO storage_entries
       (id, source_id, parent_id, path, display_name, kind, object_id, instance_id, companion_of, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'file', ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       parent_id = excluded.parent_id,
       path = excluded.path,
       display_name = excluded.display_name,
       object_id = excluded.object_id,
       instance_id = COALESCE(excluded.instance_id, storage_entries.instance_id),
       companion_of = COALESCE(excluded.companion_of, storage_entries.companion_of),
       updated_at = excluded.updated_at`,
  ).bind(
    entryId, R2_SOURCE_ID, parentId, input.logicalPath, displayName,
    objectId, input.instanceId ?? null, input.companionOf ?? null, now, now,
  ).run();
  return { objectId, physicalKey, entryId };
}

export async function findR2EntryByPath(db: D1Database, logicalPath: string): Promise<R2EntryWithObject | null> {
  const path = normalizeR2LogicalPath(logicalPath);
  return db.prepare(
    `SELECT e.id, e.source_id, e.parent_id, e.path, e.display_name, e.kind,
            e.object_id, e.instance_id, e.companion_of,
            o.physical_key, o.suffix AS object_suffix,
            o.content_type AS object_content_type, o.size AS object_size
       FROM storage_entries e
       LEFT JOIN storage_objects o ON o.id = e.object_id
      WHERE e.source_id = ? AND e.path = ?
      LIMIT 1`,
  ).bind(R2_SOURCE_ID, path).first<R2EntryWithObject>();
}

export async function updateR2EntryPath(
  db: D1Database,
  entryId: string,
  newPath: string,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  const normalized = normalizeR2LogicalPath(newPath);
  const { parentPath, displayName } = splitR2LogicalPath(normalized);
  const parentId = await ensureR2Folder(db, parentPath, now);
  await db.prepare(
    `UPDATE storage_entries
        SET parent_id = ?, path = ?, display_name = ?, updated_at = ?
      WHERE id = ? AND source_id = ?`,
  ).bind(parentId, normalized, displayName, now, entryId, R2_SOURCE_ID).run();
}
