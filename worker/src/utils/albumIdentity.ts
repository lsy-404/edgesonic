// SPDX-License-Identifier: AGPL-3.0-or-later

import { md5 } from "./md5";

export function retainCompilationAlbum(
  currentAlbum: { name: string | null; compilation: number | null } | null,
  albumName: string,
  incomingAlbumArtist: string | undefined,
  currentAlbumArtist: string | null | undefined,
): boolean {
  return currentAlbum?.compilation === 1
    && currentAlbum.name === albumName
    && (incomingAlbumArtist === undefined || incomingAlbumArtist === (currentAlbumArtist ?? undefined));
}

export function normalizeScannedAlbumName(incomingName: string, currentName: string | null | undefined): string {
  if (currentName && albumNameKey(incomingName) === albumNameKey(currentName)) return currentName;
  return incomingName;
}

export function recoverScannedAlbumName(
  incomingName: string,
  currentName: string | null | undefined,
  sourceAlbumName: string | null | undefined,
): string {
  if (!sourceAlbumName || !currentName) return incomingName;
  if (!isGenericAlbumName(currentName) && !isCodecVariantOf(currentName, sourceAlbumName)) return incomingName;
  if (isGenericAlbumName(incomingName) || isCodecVariantOf(incomingName, sourceAlbumName)) return sourceAlbumName;
  return incomingName;
}

export function needsScannedSourceAlbumRecovery(currentName: string | null | undefined): boolean {
  return !!currentName && (isGenericAlbumName(currentName) || hasCodecSuffix(currentName));
}

export function retainScannedAlbumIdentity(
  currentAlbumId: string | null | undefined,
  currentAlbumName: string | null | undefined,
  incomingAlbumName: string,
  currentAlbumArtist: string | null | undefined,
  incomingAlbumArtist: string | null | undefined,
): boolean {
  if (!currentAlbumId || !currentAlbumName || albumNameKey(incomingAlbumName) !== albumNameKey(currentAlbumName)) return false;
  return !incomingAlbumArtist || incomingAlbumArtist === currentAlbumArtist;
}

export function retainScannedVariousArtistsAlbum(
  currentAlbum: { name: string | null; compilation: number | null } | null,
  currentAlbumArtist: string | null | undefined,
  incomingAlbumName: string,
): boolean {
  return currentAlbum?.compilation === 1
    && currentAlbumArtist?.trim().toLowerCase() === "various artists"
    && !!currentAlbum.name
    && albumNameKey(incomingAlbumName) === albumNameKey(currentAlbum.name);
}

function albumNameKey(name: string): string {
  return name.normalize("NFC").replace(/[『』]/g, "").replace(/\s+/gu, "").toLowerCase();
}

export async function sourceFolderAlbumId(
  db: D1Database,
  instanceId: string,
  albumName: string,
  suffix: string,
): Promise<string | null> {
  const entries = (await db.prepare(
    "SELECT source_id, parent_id FROM storage_entries WHERE instance_id = ? AND kind = 'file' LIMIT 2",
  ).bind(instanceId).all<{ source_id: string; parent_id: string | null }>()).results;
  if (entries.length !== 1) return null;

  const entry = entries[0];
  const identity = [
    "source-folder",
    entry.source_id,
    entry.parent_id ?? "",
    suffix.toLowerCase(),
    albumName.normalize("NFC").trim().toLowerCase(),
  ].join("\0");
  return "al-" + md5(identity);
}

export async function sourceFolderAlbumIdForScan(
  db: D1Database,
  instanceId: string,
  currentAlbumId: string | null,
  currentAlbumName: string | null,
  albumName: string,
  suffix: string,
): Promise<string | null> {
  const folderAlbumId = await sourceFolderAlbumId(db, instanceId, albumName, suffix);
  if (!folderAlbumId) return null;
  if (currentAlbumId === "pending-uploads") return folderAlbumId;
  if (!currentAlbumId || !currentAlbumName) return null;
  if (isGenericAlbumName(currentAlbumName) || isCodecVariantOf(currentAlbumName, albumName) || isGenericAlbumName(albumName)) {
    const entries = (await db.prepare(
      "SELECT source_id, parent_id FROM storage_entries WHERE instance_id = ? AND kind = 'file' LIMIT 2",
    ).bind(instanceId).all<{ source_id: string; parent_id: string | null }>()).results;
    if (entries.length !== 1) return null;
    const entry = entries[0];
    const matchingAlbums = (await db.prepare(
      `SELECT DISTINCT sm.album_id AS id
         FROM storage_entries se
         JOIN song_instances si ON si.id = se.instance_id
         JOIN song_masters sm ON sm.id = si.master_id
         JOIN albums a ON a.id = sm.album_id
        WHERE se.source_id = ? AND se.parent_id IS ? AND se.kind = 'file'
          AND sm.album_id != ? AND a.name = ?
        LIMIT 2`,
    ).bind(entry.source_id, entry.parent_id, currentAlbumId, albumName).all<{ id: string }>()).results;
    if (matchingAlbums.length === 1) return matchingAlbums[0].id;
    if (matchingAlbums.length > 1) return null;
    if (isGenericAlbumName(currentAlbumName) || isCodecVariantOf(currentAlbumName, albumName)) return folderAlbumId;
  }
  const currentFolderId = currentAlbumName === albumName
    ? folderAlbumId
    : await sourceFolderAlbumId(db, instanceId, currentAlbumName, suffix);
  return currentFolderId === currentAlbumId ? folderAlbumId : null;
}

function isGenericAlbumName(name: string): boolean {
  return /^(?:unknown album|unknown|album|wav|flac|mp3|m4a|aac|ogg|opus|ape)$/i.test(name.trim());
}

function isCodecVariantOf(name: string, albumName: string): boolean {
  const escaped = albumName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}\\s*[（(［\\[]\\s*(?:wav|flac|mp3|m4a|aac|ape|ogg|opus)\\s*[）)］\\]]$`, "i").test(name.trim());
}

function hasCodecSuffix(name: string): boolean {
  return /[（(［\[]\s*(?:wav|flac|mp3|m4a|aac|ape|ogg|opus)\s*[）)］\]]$/i.test(name.trim());
}

export function compilationMarkerStatement(db: D1Database, albumId: string): D1PreparedStatement {
  return db.prepare(
    `UPDATE albums SET compilation = 1 WHERE id = ? AND EXISTS (
       SELECT 1 FROM song_masters first
       JOIN song_masters other ON other.album_id = first.album_id AND other.id != first.id
       WHERE first.album_id = ? AND (
         first.artist_id != other.artist_id OR
         COALESCE(first.album_artist_id, '') != COALESCE(other.album_artist_id, '')
       )
     )`,
  ).bind(albumId, albumId);
}
