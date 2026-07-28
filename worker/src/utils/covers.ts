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

import { locateEmbeddedPicture } from "./tags";
import { resolveImageMime } from "./imageType";
import { encodePath } from "../endpoints/storage/scan";
import { TAIL_BYTES as WAV_TAIL_BYTES } from "./slices";

const HEAD_BYTES = 256 * 1024;
const MAX_PICTURE_BYTES = 8 * 1024 * 1024;

interface SourceRow {
  id: string;
  base_url: string;
  username: string | null;
  password: string | null;
  root_path: string | null;
}


// Pulls the embedded picture out of one stored file. Shared by the album and
// per-song resolvers so both read the same formats through the same paths.
async function extractFromInstance(
  env: Env,
  inst: { storage_uri: string; size: number | null },
): Promise<{ body: ReadableStream<Uint8Array> | Uint8Array; contentType: string } | null> {
  const db = env.DB;
  if (inst.storage_uri.startsWith("webdav://")) {
    const rest = inst.storage_uri.substring(9);
    const slash = rest.indexOf("/");
    const sourceId = rest.substring(0, slash);
    const filePath = rest.substring(slash + 1);
    const src = await db.prepare(
      "SELECT id, base_url, username, password, root_path FROM storage_sources WHERE id = ? AND enabled = 1"
    ).bind(sourceId).first<SourceRow>();
    if (!src) return null;

    const root = (src.root_path || "").replace(/^\/+|\/+$/g, "");
    const baseUrl = src.base_url.replace(/\/+$/, "") + (root ? `/${root}` : "");
    const auth = `Basic ${btoa(`${src.username || ""}:${src.password || ""}`)}`;
    return extractEmbedded((range) => fetchWebdavRange(baseUrl, auth, filePath, range), inst.size ?? undefined);
  }
  if (inst.storage_uri.startsWith("r2://")) {
    const key = inst.storage_uri.substring(5);
    return extractEmbedded(async (range) => {
      const obj = await env.MUSIC_BUCKET.get(key, { range });
      return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
    }, inst.size ?? undefined);
  }
  return null;
}

/**
 * On-demand album cover resolution — EMBEDDED ART ONLY (102).
 *
 * 076 removed the directory-image fallback (cover/folder/front/albumart in
 * the file's parent dir): a shared NAS-root cover.jpg got assigned to every
 * child album. Embedded art (ID3v2 APIC / FLAC PICTURE) has no such hazard
 * the picture lives inside one of the album's own files — so 102 re-enables
 * the on-demand path restricted to embedded extraction. Albums without
 * embedded art keep cover_r2_key NULL and getCoverArt keeps returning 404.
 * The result is cached in R2 (covers/<albumId>) and albums.cover_r2_key.
 */
export async function resolveAlbumCover(env: Env, albumId: string): Promise<string | null> {
  const db = env.DB;
  const inst = await db.prepare(
    `SELECT si.storage_uri, si.size FROM song_instances si
     JOIN song_masters sm ON sm.id = si.master_id
     WHERE sm.album_id = ? AND si.missing = 0
     ORDER BY CASE WHEN si.storage_uri LIKE 'webdav://%' THEN 0 ELSE 1 END
     LIMIT 1`
  ).bind(albumId).first<{ storage_uri: string; size: number | null }>();
  if (!inst) return null;

  const image = await extractFromInstance(env, inst);
  if (!image) return null;
  const coverKey = `covers/${albumId}`;
  // extractEmbedded always hands back the bytes for this path, so the stored
  // media type can be taken from the artwork itself rather than the tag's
  // often-unusable declaration.
  const bytes = image.body instanceof Uint8Array ? image.body : new Uint8Array();
  await env.MUSIC_BUCKET.put(coverKey, image.body, {
    httpMetadata: { contentType: resolveImageMime(image.contentType, bytes) },
  });
  await db.prepare("UPDATE albums SET cover_r2_key = ?, updated_at = ? WHERE id = ?")
    .bind(coverKey, Math.floor(Date.now() / 1000), albumId).run();
  return coverKey;
}

export async function extractEmbedded(
  fetchRange: (range: { offset: number; length: number }) => Promise<Uint8Array | null>,
  totalSize?: number,
): Promise<{ body: Uint8Array; contentType: string } | null> {
  const head = await fetchRange({ offset: 0, length: HEAD_BYTES });
  if (!head || head.length === 0) return null;

  // an APIC picture) AFTER the audio "data" payload, well past a head-only
  // window on anything but a tiny file. Fetch a tail slice too whenever we
  // know the file is bigger than one head window (a smaller file's "tail"
  // would just re-fetch bytes already in head — skip the redundant request).
  //
 // WAV needs a much bigger tail window than other formats: rippers commonly
  // append the whole "id3 " chunk (tags + APIC art) after "data", and that
  // chunk's own size scales with the embedded picture — the same class of
  // bug 111 already fixed for the /tag/read text-tag path (slices.ts grew
  // its tail from 128KB to 2MB for exactly this reason). This on-demand
  // cover path had its own separate 256KB tail that was never updated, so a
  // WAV's id3/APIC chunk starting further back than 256KB from EOF was
  // silently never found — reuse slices.ts's constant to stay in sync.
  const isWav = head.length >= 4 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46;
  const tailWindow = isWav ? WAV_TAIL_BYTES : HEAD_BYTES;
  let tail: Uint8Array | undefined;
  let tailStart = 0;
  if (totalSize && totalSize > HEAD_BYTES + tailWindow) {
    tailStart = totalSize - tailWindow;
    tail = (await fetchRange({ offset: tailStart, length: tailWindow })) ?? undefined;
  }

  const pic = locateEmbeddedPicture(head, tail);
  if (!pic || pic.length > MAX_PICTURE_BYTES) return null;

  // pic.offset is relative to whichever buffer matched (head, or tail when
  // pic.source === "tail") — translate to an absolute file offset only when
  // we need a follow-up fetch beyond what's already in hand.
  const buf = pic.source === "tail" ? tail! : head;
  const absoluteOffset = pic.source === "tail" ? tailStart + pic.offset : pic.offset;

  // Fully contained in the buffer we already fetched — no extra request needed
  if (pic.offset + pic.length <= buf.length) {
    return { body: buf.subarray(pic.offset, pic.offset + pic.length), contentType: pic.mime };
  }
  const data = await fetchRange({ offset: absoluteOffset, length: pic.length });
  if (!data || data.length < pic.length) return null;
  return { body: data, contentType: pic.mime };
}

async function fetchWebdavRange(
  baseUrl: string,
  auth: string,
  filePath: string,
  range: { offset: number; length: number },
): Promise<Uint8Array | null> {
  const resp = await fetch(baseUrl + "/" + encodePath(filePath), {
    headers: { Authorization: auth, Range: `bytes=${range.offset}-${range.offset + range.length - 1}` },
  });
  if (!resp.ok && resp.status !== 206) return null;
  if (!resp.body) return null;
  // Guard against servers that ignore Range and send the whole file
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < range.length) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(total, range.length));
  let off = 0;
  for (const ch of chunks) {
    const n = Math.min(ch.length, out.length - off);
    out.set(ch.subarray(0, n), off);
    off += n;
    if (off >= out.length) break;
  }
  return out;
}

/**
 * On-demand per-song cover resolution.
 *
 * A compilation carries different artwork per track, but every song in an
 * album otherwise shares one picture. So the bytes are extracted from the
 * song's own file and, when they match the album's cover, the song simply
 * points at that existing object instead of storing a duplicate — one row
 * update rather than a second copy of the same image per track.
 *
 * Returns the key to serve, or null when the file carries no artwork.
 */
export async function resolveSongCover(env: Env, songId: string): Promise<string | null> {
  const db = env.DB;
  const inst = await db.prepare(
    `SELECT storage_uri, size FROM song_instances
     WHERE master_id = ? AND missing = 0
     ORDER BY CASE WHEN storage_uri LIKE 'webdav://%' THEN 0 ELSE 1 END
     LIMIT 1`,
  ).bind(songId).first<{ storage_uri: string; size: number | null }>();
  if (!inst) return null;

  const image = await extractFromInstance(env, inst);
  if (!image) return null;
  const bytes = image.body instanceof Uint8Array ? image.body : new Uint8Array();

  // Same picture as the album's? Reuse that object.
  const album = await db.prepare(
    `SELECT a.cover_r2_key FROM albums a
     JOIN song_masters sm ON sm.album_id = a.id
     WHERE sm.id = ? AND a.cover_r2_key IS NOT NULL`,
  ).bind(songId).first<{ cover_r2_key: string }>();
  let coverKey = `covers/sg-${songId}`;
  if (album) {
    const existing = await env.MUSIC_BUCKET.head(album.cover_r2_key);
    if (existing && existing.size === bytes.length) coverKey = album.cover_r2_key;
  }

  if (coverKey !== album?.cover_r2_key) {
    await env.MUSIC_BUCKET.put(coverKey, bytes, {
      httpMetadata: { contentType: resolveImageMime(image.contentType, bytes) },
    });
  }
  await db.prepare("UPDATE song_masters SET cover_r2_key = ?, updated_at = ? WHERE id = ?")
    .bind(coverKey, Math.floor(Date.now() / 1000), songId).run();
  return coverKey;
}
