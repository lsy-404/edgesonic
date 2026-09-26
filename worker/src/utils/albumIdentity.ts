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
  return "al-" + md5(identity).substring(0, 10);
}

export async function markCompilationIfMixed(db: D1Database, albumId: string): Promise<void> {
  await db.prepare(
    `UPDATE albums SET compilation = 1 WHERE id = ? AND EXISTS (
       SELECT 1 FROM song_masters first
       JOIN song_masters other ON other.album_id = first.album_id AND other.id != first.id
       WHERE first.album_id = ? AND (
         first.artist_id != other.artist_id OR
         COALESCE(first.album_artist_id, '') != COALESCE(other.album_artist_id, '')
       )
     )`,
  ).bind(albumId, albumId).run();
}
