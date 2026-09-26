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

import { md5 } from "./md5";
import { compilationMarkerStatement, retainCompilationAlbum, sourceFolderAlbumIdForScan } from "./albumIdentity";
import { deriveBitrate } from "./audioMetrics";
import {
  artistInsertStatements,
  parseAlbumArtistCredit,
  parseArtistCredits,
  songArtistStatements,
} from "./artistCredits";
import { recoverMetadataFromStoragePath } from "./storageMetadata";

export interface SubmittedMetadata {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  genre?: string;
  year?: number;
  track?: number;
  disc?: number;
  duration?: number;     // seconds
  bitrate?: number;      // kbps
  sampleRate?: number;   // Hz
  bitDepth?: number;     // bits per sample
  channels?: number;
  lyrics?: string;
  container?: string;
  codec?: string;
}

export interface MetaCommon {
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  albumArtist?: unknown;
  genre?: unknown;
  year?: unknown;
  track?: unknown;
  disc?: unknown;
  lyrics?: unknown;
}
export interface MetaFormat {
  bitrate?: unknown;
  sampleRate?: unknown;
  bitDepth?: unknown;
  channels?: unknown;
  duration?: unknown;
  container?: unknown;
  codec?: unknown;
}

export interface ApplyResult {
  updated: boolean;
  masterId?: string;
  reason?: string;     // populated on `updated:false` to help admins debug backfill failures
}

export async function applyMetadataResult(
  db: D1Database,
  instanceId: string,
  common: MetaCommon | undefined | null,
  format: MetaFormat | undefined | null,
): Promise<ApplyResult> {
  if (!instanceId || typeof instanceId !== "string") {
    return { updated: false, reason: "missing instanceId" };
  }

  // Normalize numeric tag values before binding them to SQLite.
  let tags = mergeToSubmitted(common ?? {}, format ?? {});

  // An empty scan must not replace artist or album with unknown sentinels.
  const hasLogical =
    !!(tags.title || tags.artist || tags.album || tags.albumArtist ||
       tags.genre || tags.year || tags.track || tags.disc);

  const inst = await db.prepare(
    "SELECT id, master_id, size, storage_uri, suffix FROM song_instances WHERE id = ?",
  ).bind(instanceId).first<{ id: string; master_id: string; size: number | null; storage_uri: string; suffix: string }>();
  if (!inst) return { updated: false, reason: "instance not found" };
  tags = recoverMetadataFromStoragePath(inst.storage_uri, tags);

  let masterId: string | undefined;
  if (hasLogical) {
    const master = await db.prepare(
      "SELECT id, album_id, artist_id, album_artist_id, title FROM song_masters WHERE id = ?",
    ).bind(inst.master_id).first<{
      id: string; album_id: string; artist_id: string; album_artist_id: string | null; title: string;
    }>();
    if (!master) return { updated: false, reason: "master not found" };
    const currentAlbum = master.album_id === "pending-uploads" ? null
      : await db.prepare("SELECT name FROM albums WHERE id = ?")
        .bind(master.album_id).first<{ name: string }>();
    const scanAlbumName = tags.album || currentAlbum?.name;
    const importAlbumId = scanAlbumName
      ? await sourceFolderAlbumIdForScan(db, instanceId, master.album_id,
        currentAlbum?.name ?? null, scanAlbumName, inst.suffix)
      : null;
    await relinkArtistAlbum(db, master, tags, importAlbumId);
    masterId = master.id;
  } else {
    masterId = inst.master_id;
  }

  // Embedded lyrics fill empty values without replacing user or sidecar lyrics.
  if (tags.lyrics) {
    await db.prepare(
      "UPDATE song_masters SET lyrics = COALESCE(NULLIF(lyrics, ''), ?), updated_at = ? WHERE id = ?",
    ).bind(tags.lyrics, Math.floor(Date.now() / 1000), inst.master_id).run();
  }

  // Subsonic album views read duration from song_masters.
  const masterSets: string[] = [];
  const masterBinds: unknown[] = [];
  if (typeof tags.duration === "number" && tags.duration > 0) {
    masterSets.push("duration = ?");
    masterBinds.push(tags.duration);
  }
  if (tags.genre) {
    masterSets.push("genre = COALESCE(genre, ?)");
    masterBinds.push(tags.genre);
  }
  if (masterSets.length > 0) {
    masterSets.push("updated_at = ?");
    masterBinds.push(Math.floor(Date.now() / 1000));
    masterBinds.push(inst.master_id);
    await db.prepare(`UPDATE song_masters SET ${masterSets.join(", ")} WHERE id = ?`)
      .bind(...masterBinds).run();
  }

  // Mark parsed instances even when no physical parameter was available.
  const sets: string[] = [];
  const binds: unknown[] = [];
  // Slice-derived bitrate is unreliable, so prefer size divided by duration.
  const measuredBitrate = deriveBitrate(inst.size, tags.duration);
  const bitrate = measuredBitrate ?? (typeof tags.bitrate === "number" ? tags.bitrate : null);
  if (bitrate !== null)                    { sets.push("bit_rate = ?");    binds.push(bitrate); }
  if (typeof tags.sampleRate === "number") { sets.push("sample_rate = ?"); binds.push(tags.sampleRate); }
  if (typeof tags.bitDepth === "number")   { sets.push("bit_depth = ?");   binds.push(tags.bitDepth); }
  if (typeof tags.channels === "number")   { sets.push("channels = ?");    binds.push(tags.channels); }
  if (typeof tags.duration === "number")   { sets.push("duration = ?");    binds.push(tags.duration); }
  sets.push("tag_scanned = 1");
  sets.push("updated_at = ?");
  binds.push(Math.floor(Date.now() / 1000));
  binds.push(inst.id);
  await db.prepare(`UPDATE song_instances SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds).run();

  return { updated: true, masterId };
}

export async function relinkArtistAlbum(
  db: D1Database,
  master: { id: string; album_id: string; artist_id: string; album_artist_id: string | null; title: string },
  tags: SubmittedMetadata,
  importAlbumId: string | null = null,
): Promise<{ albumId: string; artistId: string }> {
  const now = Math.floor(Date.now() / 1000);

  // Omitted tag fields keep their current artist and album names.
  const curArtist = await db.prepare("SELECT name FROM artists WHERE id = ?")
    .bind(master.artist_id).first<{ name: string }>();
  const curAlbum = await db.prepare("SELECT name, compilation FROM albums WHERE id = ?")
    .bind(master.album_id).first<{ name: string; compilation: number }>();
  const title = tags.title || master.title;
  const artistChanged = tags.artist !== undefined;
  const artistName = tags.artist || curArtist?.name || "Unknown Artist";
  const artistCredits = artistChanged ? parseArtistCredits(artistName) : [];
  const currentAlbumArtist = master.album_artist_id
    ? await db.prepare("SELECT name FROM artists WHERE id = ?").bind(master.album_artist_id).first<{ name: string }>()
    : null;
  const albumArtistName = tags.albumArtist === undefined ? currentAlbumArtist?.name : tags.albumArtist;
  const albumArtist = parseAlbumArtistCredit(albumArtistName);
  const albumArtistCredits = albumArtist ? [albumArtist] : [];
  const primaryArtist = artistCredits[0];
  const linkArtistName = albumArtist?.name || primaryArtist?.name || curArtist?.name || "Unknown Artist";
  const albumName = tags.album || curAlbum?.name || "Unknown Album";
  const artistId = primaryArtist?.id || master.artist_id;
  const albumIdentityChanged = artistChanged || tags.albumArtist !== undefined || tags.album !== undefined;
  const albumId = importAlbumId ?? (albumIdentityChanged && !retainCompilationAlbum(curAlbum, albumName, tags.albumArtist, currentAlbumArtist?.name)
    ? "al-" + md5(linkArtistName + " " + albumName).substring(0, 10)
    : master.album_id);
  const oldAlbumId = master.album_id;
  const oldSongArtistIds = artistChanged
    ? (await db.prepare("SELECT artist_id FROM song_artists WHERE song_id = ?")
      .bind(master.id).all<{ artist_id: string }>()).results.map((row) => row.artist_id)
    : [];
  const cleanupArtistIds = new Set<string>();
  if (artistChanged) {
    cleanupArtistIds.add(master.artist_id);
    oldSongArtistIds.forEach((id) => cleanupArtistIds.add(id));
  }
  if (tags.albumArtist !== undefined && albumArtist?.id !== master.album_artist_id && master.album_artist_id) {
    cleanupArtistIds.add(master.album_artist_id);
  }

  await db.batch([
    ...artistInsertStatements(db, [...artistCredits, ...albumArtistCredits], now),
    db.prepare("INSERT OR IGNORE INTO albums (id, name, sort_name, year, genre, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(albumId, albumName, albumName.toLowerCase(), tags.year ?? null, tags.genre ?? null, now, now),
    db.prepare(
      `UPDATE song_masters SET
         album_id = ?, artist_id = ?, album_artist_id = COALESCE(?, album_artist_id), title = ?, sort_title = ?,
         track = COALESCE(?, track), disc = COALESCE(?, disc),
         genre = COALESCE(?, genre), duration = COALESCE(?, duration),
         updated_at = ?
       WHERE id = ?`,
    ).bind(
      albumId, artistId, albumArtist?.id ?? null, title, title.toLowerCase(),
      tags.track ?? null, tags.disc ?? null,
      tags.genre ?? null, tags.duration ?? null,
      now, master.id,
    ),
    ...(artistChanged ? songArtistStatements(db, master.id, artistCredits) : []),
    ...(importAlbumId ? [compilationMarkerStatement(db, albumId)] : []),
  ]);

  // Existing album rows can lack year or genre after INSERT OR IGNORE.
  if (tags.year || tags.genre) {
    await db.prepare("UPDATE albums SET year = COALESCE(?, year), genre = COALESCE(?, genre), updated_at = ? WHERE id = ?")
      .bind(tags.year ?? null, tags.genre ?? null, now, albumId).run();
  }

  // Both album aggregates change when a track moves.
  for (const aid of new Set([albumId, oldAlbumId])) {
    await db.prepare(
      `UPDATE albums SET
         song_count = (SELECT COUNT(*) FROM song_masters WHERE album_id = ?),
         size = (SELECT COALESCE(SUM(si.size), 0) FROM song_instances si
                 JOIN song_masters sm ON sm.id = si.master_id WHERE sm.album_id = ?),
         updated_at = ?
       WHERE id = ?`,
    ).bind(aid, aid, now, aid).run();
  }
  if (oldAlbumId !== albumId) {
    await db.prepare(
      "DELETE FROM albums WHERE id = ? AND NOT EXISTS (SELECT 1 FROM song_masters WHERE album_id = ?)",
    ).bind(oldAlbumId, oldAlbumId).run();
  }
  if (cleanupArtistIds.size > 0) {
    const ids = [...cleanupArtistIds];
    const placeholders = ids.map(() => "?").join(", ");
    await db.prepare(
      `DELETE FROM artists WHERE id IN (${placeholders})
        AND NOT EXISTS (SELECT 1 FROM song_masters WHERE artist_id = artists.id)
        AND NOT EXISTS (SELECT 1 FROM song_masters WHERE album_artist_id = artists.id)
        AND NOT EXISTS (SELECT 1 FROM song_artists WHERE artist_id = artists.id)`,
    ).bind(...ids).run();
  }

  return { albumId, artistId };
}

function mergeToSubmitted(c: MetaCommon, f: MetaFormat): SubmittedMetadata {
  const out: SubmittedMetadata = {};
  const t = trimStr(c.title);        if (t) out.title       = t;
  const ar = trimStr(c.artist);      if (ar) out.artist      = ar;
  const al = trimStr(c.album);       if (al) out.album       = al;
  const aa = trimStr(c.albumArtist); if (aa) out.albumArtist = aa;
  const g = trimStr(c.genre);        if (g) out.genre       = g;

  const year = toPosInt(c.year);     if (year !== null) out.year  = year;
  const track = toPosInt(c.track);   if (track !== null) out.track = track;
  const disc = toPosInt(c.disc);     if (disc !== null) out.disc  = disc;
  const ly = trimStr(c.lyrics);      if (ly) out.lyrics = ly;

  const dur = toPosNum(f.duration);  if (dur !== null) out.duration   = dur;
  const br = toPosNum(f.bitrate);    if (br !== null) out.bitrate    = br;
  const sr = toPosNum(f.sampleRate); if (sr !== null) out.sampleRate = sr;
  const bd = toPosNum(f.bitDepth);   if (bd !== null) out.bitDepth   = bd;
  const ch = toPosNum(f.channels);   if (ch !== null) out.channels   = ch;
  const cont = trimStr(f.container); if (cont) out.container = cont;
  const cdc = trimStr(f.codec);      if (cdc) out.codec     = cdc;
  return out;
}

function trimStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s : undefined;
}
function toPosInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isInteger(n) && n > 0) return n;
  return null;
}
function toPosNum(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  return null;
}
