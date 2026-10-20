// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Read-only library diagnostics. One catalog snapshot feeds four reports:
//  - songs that look like the same recording under different masters,
//  - albums that look like the same release under different album ids,
//  - folders whose tracks were split into several albums or carry
//    inconsistent album artists / track numbers,
//  - data errors (object-key placeholders, unknown durations, ghosts, stale
//    album totals ...).
// Every report carries the plan the fix endpoint will execute, so the UI can
// show exactly what changes before anything is written.

import { instrumentalBaseTitle, isInstrumentalTitle } from "../../../shared/instrumental";
import { isKnownMetadataIdentity } from "../../../shared/metadataRetrievalMatch";
import { isGenericAlbumName } from "./albumIdentity";
import { parseFingerprint } from "./audioFingerprint";
import { chooseSurvivorMaster, type MergeableMaster } from "./catalogMerge";
import { parseArtistCredits } from "./artistCredits";
import {
  albumNameFromSourcePath,
  canRecoverLogicalTrackTitle,
  isObjectTitle,
  looksLossy,
  recoverMetadataFromLogicalPath,
} from "./storageMetadata";

const PLACEHOLDER_ALBUM = "pending-uploads";
const DURATION_TOLERANCE = 2;
const REPORT_LIMIT = 300;

// ---------------------------------------------------------------------------
// Normalized keys
// ---------------------------------------------------------------------------

function nfkcLower(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").toLowerCase().trim();
}

// Backing-track and live markers stay in the key: "曲名" and "曲名 (Inst.)"
// are different recordings and must never be proposed as duplicates.
export function songTitleKey(title: string | null | undefined): string {
  const value = nfkcLower(title);
  const withoutNumber = value.replace(/^\d{1,3}(?:\s*[._、-]\s*|\s+)(?=\S)/u, "");
  return withoutNumber.replace(/[『』「」"“”'‘’]/gu, "").replace(/\s+/gu, "");
}

// A trailing label naming a format or quality marks a copy of the same
// release: "(FLAC)", "（WAV版）", "（赠品MP3）", " - MP3 320 kbps", " - FLAC 16-bit".
const VARIANT_TOKEN = String.raw`(?:wav|flac|mp3|m4a|aac|ape|ogg|opus|alac|dsd|hi-?res|\d{3}\s*k(?:bps)?|\d{2}[- ]?bit|无损|有损)`;
const BRACKET_VARIANT = new RegExp(String.raw`\s*[(\[【][^()\[\]【】]*?${VARIANT_TOKEN}[^()\[\]【】]*[)\]】]\s*$`, "iu");
const DASH_VARIANT = new RegExp(String.raw`\s+[-–—]\s+[^-–—]*?${VARIANT_TOKEN}[^-–—]*$`, "iu");

export function albumTitleKey(name: string | null | undefined): string {
  let value = nfkcLower(name);
  for (let previous = ""; previous !== value;) {
    previous = value;
    value = value.replace(BRACKET_VARIANT, "").replace(DASH_VARIANT, "").trim();
  }
  return value.replace(/[『』「」]/gu, "").replace(/\s+/gu, "");
}

const UNKNOWN_ARTIST = /^(?:未知艺术家|未知歌手|未知艺人|未知)$/u;

function knownArtist(name: string | null | undefined): boolean {
  return isKnownMetadataIdentity(name) && !UNKNOWN_ARTIST.test(artistKey(name));
}

/**
 * Whether two track-artist tags can describe the same recording: equal, one
 * credit containing the other ("跳蝻P feat. 洛天依" / "洛天依"), or either
 * side unknown.
 */
export function artistsRelated(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!knownArtist(a) || !knownArtist(b)) return true;
  const left = artistKey(a);
  const right = artistKey(b);
  return left === right || left.includes(right) || right.includes(left);
}

export function artistKey(name: string | null | undefined): string {
  return nfkcLower(name).replace(/\s+/gu, " ");
}

/** Lower-cased individual names in an artist credit ("A, B" -> ["a", "b"]). */
export function albumArtistCredits(name: string | null | undefined): string[] {
  if (!name?.trim()) return [];
  return parseArtistCredits(name).map((credit) => artistKey(credit.name));
}

export function mostCommon<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  let best: T | undefined;
  let bestCount = 0;
  for (const value of values) {
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    if (count > bestCount) { best = value; bestCount = count; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface SongRow extends MergeableMaster {
  album_name: string | null;
  artist_name: string | null;
  album_artist_name: string | null;
}

export interface InstanceRow {
  id: string;
  master_id: string;
  source_id: string;
  source_type: string | null;
  parent_instance_id: string | null;
  storage_uri: string;
  storage_object_id: string | null;
  suffix: string;
  bit_rate: number | null;
  sample_rate: number | null;
  bit_depth: number | null;
  duration: number | null;
  size: number | null;
  missing: number | null;
  source_dedup_key: string | null;
  created_at: number | null;
  etag: string | null;
  object_size: number | null;
}

export interface EntryRow {
  instance_id: string;
  source_id: string;
  parent_id: string | null;
  path: string;
}

export interface AlbumRow {
  id: string;
  name: string;
  year: number | null;
  cover_r2_key: string | null;
  song_count: number | null;
  duration: number | null;
  size: number | null;
  compilation: number | null;
  created_at: number | null;
}

export interface CatalogSnapshot {
  songs: SongRow[];
  instances: InstanceRow[];
  albums: AlbumRow[];
  objectArtists: Array<{ id: string; name: string }>;
  songsById: Map<string, SongRow>;
  albumsById: Map<string, AlbumRow>;
  instancesByMaster: Map<string, InstanceRow[]>;
  /** Logical file entry of an instance, present only when it is unambiguous. */
  entryByInstance: Map<string, EntryRow>;
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list) list.push(item); else groups.set(k, [item]);
  }
  return groups;
}

// Long text columns are reduced to a presence marker: the survivor score only
// needs to know whether lyrics exist, and a full-library scan should not pull
// every lyric sheet into the worker.
const SONG_SELECT =
  `SELECT sm.id, sm.title, sm.artist_id, sm.album_id, sm.album_artist_id, sm.cover_r2_key,
          sm.sort_title, sm.track, sm.disc, sm.duration, sm.genre, sm.created_at,
          CASE WHEN COALESCE(sm.participants, '') = '' THEN NULL ELSE '1' END AS participants,
          CASE WHEN COALESCE(sm.lyrics, '') = '' THEN NULL ELSE '1' END AS lyrics,
          CASE WHEN COALESCE(sm.lyrics_rich, '') = '' THEN NULL ELSE '1' END AS lyrics_rich,
          al.name AS album_name, ar.name AS artist_name, aa.name AS album_artist_name
   FROM song_masters sm
   LEFT JOIN albums al ON al.id = sm.album_id
   LEFT JOIN artists ar ON ar.id = sm.artist_id
   LEFT JOIN artists aa ON aa.id = sm.album_artist_id`;

const INSTANCE_SELECT =
  `SELECT si.id, si.master_id, si.source_id, si.source_type, si.parent_instance_id, si.storage_uri,
          si.storage_object_id, si.suffix, si.bit_rate, si.sample_rate, si.bit_depth, si.duration,
          si.size, si.missing, si.source_dedup_key, si.created_at,
          COALESCE(so.etag, si.source_etag) AS etag, so.size AS object_size
   FROM song_instances si
   LEFT JOIN storage_objects so ON so.id = si.storage_object_id`;

const ENTRY_SELECT =
  "SELECT instance_id, source_id, parent_id, path FROM storage_entries WHERE kind = 'file' AND instance_id IS NOT NULL";

const ALBUM_SELECT = "SELECT id, name, year, cover_r2_key, song_count, duration, size, compilation, created_at FROM albums";

// Runs `sql` once per chunk of ids, appending `AND <column> IN (...)` (or
// WHERE when the statement has none); stays under D1's bound-parameter cap.
async function selectIn<T>(db: D1Database, sql: string, column: string, ids: string[]): Promise<T[]> {
  const rows: T[] = [];
  const unique = [...new Set(ids)];
  const joiner = /\bWHERE\b/i.test(sql) ? "AND" : "WHERE";
  for (let i = 0; i < unique.length; i += 80) {
    const chunk = unique.slice(i, i + 80);
    rows.push(...(await db.prepare(`${sql} ${joiner} ${column} IN (${chunk.map(() => "?").join(", ")})`)
      .bind(...chunk).all<T>()).results);
  }
  return rows;
}

export interface SnapshotScope {
  songIds?: string[];
  albumIds?: string[];
}

/**
 * Loads the catalog, or with a scope only the given songs/albums plus their
 * instances, entries and albums. Fix endpoints re-plan on a scoped snapshot
 * so they act on current rows rather than on what the client last saw.
 */
export async function loadCatalogSnapshot(db: D1Database, scope?: SnapshotScope): Promise<CatalogSnapshot> {
  let songs: SongRow[];
  let instances: InstanceRow[];
  let entries: EntryRow[];
  let albums: AlbumRow[];
  let objectArtists: Array<{ id: string; name: string }> = [];
  if (scope) {
    songs = [
      ...await selectIn<SongRow>(db, SONG_SELECT, "sm.id", scope.songIds ?? []),
      ...await selectIn<SongRow>(db, SONG_SELECT, "sm.album_id", scope.albumIds ?? []),
    ].filter((song, index, all) => all.findIndex((other) => other.id === song.id) === index);
    instances = await selectIn<InstanceRow>(db, INSTANCE_SELECT, "si.master_id", songs.map((song) => song.id));
    entries = await selectIn<EntryRow>(db, ENTRY_SELECT, "instance_id", instances.map((instance) => instance.id));
    albums = await selectIn<AlbumRow>(db, ALBUM_SELECT, "id", [
      ...(scope.albumIds ?? []),
      ...songs.map((song) => song.album_id).filter((id): id is string => !!id),
    ]);
  } else {
    songs = (await db.prepare(SONG_SELECT).all<SongRow>()).results;
    instances = (await db.prepare(INSTANCE_SELECT).all<InstanceRow>()).results;
    entries = (await db.prepare(ENTRY_SELECT).all<EntryRow>()).results;
    albums = (await db.prepare(ALBUM_SELECT).all<AlbumRow>()).results;
    objectArtists = (await db.prepare(
      "SELECT id, name FROM artists WHERE lower(trim(name)) = 'obj' OR lower(trim(name)) GLOB 'obj_[0-9a-f]*'",
    ).all<{ id: string; name: string }>()).results.filter((row) => isObjectTitle(row.name));
  }

  const entryByInstance = new Map<string, EntryRow>();
  for (const [instanceId, rows] of groupBy(entries, (row) => row.instance_id)) {
    if (rows.length === 1) entryByInstance.set(instanceId, rows[0]);
  }
  return {
    songs,
    instances,
    albums,
    objectArtists,
    songsById: new Map(songs.map((row) => [row.id, row])),
    albumsById: new Map(albums.map((row) => [row.id, row])),
    instancesByMaster: groupBy(instances, (row) => row.master_id),
    entryByInstance,
  };
}

// ---------------------------------------------------------------------------
// Instances: quality, data match and retirement planning
// ---------------------------------------------------------------------------

const LOSSLESS = new Set(["flac", "wav", "aiff", "aif", "ape", "wv", "alac", "tta", "dsf", "dff"]);
const FORMAT_PREFERENCE = ["flac", "alac", "wav", "aiff", "aif", "wv", "ape", "tta", "dsf", "dff", "opus", "m4a", "aac", "ogg", "mp3"];

export function isPrimaryInstance(instance: Pick<InstanceRow, "parent_instance_id" | "source_type">): boolean {
  return !instance.parent_instance_id && instance.source_type !== "transcoded" && instance.source_type !== "cached";
}

const VIDEO_SUFFIXES = new Set(["mp4", "m4v", "mkv", "webm", "mov", "avi", "flv"]);

/** Video copies (a song's music video or "视频版") are never treated as duplicate audio. */
export function isVideoInstance(instance: Pick<InstanceRow, "suffix">): boolean {
  return VIDEO_SUFFIXES.has(instance.suffix.toLowerCase());
}

function isVideoOnlySong(snapshot: CatalogSnapshot, songId: string): boolean {
  const primaries = (snapshot.instancesByMaster.get(songId) ?? []).filter(isPrimaryInstance);
  return primaries.length > 0 && primaries.every(isVideoInstance);
}

function formatRank(suffix: string): number {
  const index = FORMAT_PREFERENCE.indexOf(suffix.toLowerCase());
  return index < 0 ? FORMAT_PREFERENCE.length : index;
}

/**
 * Negative when `a` is the better copy to keep. Bitrate only ranks lossy
 * copies: between lossless files it measures compression, not quality, and
 * would rank a WAV above the identical FLAC.
 */
export function compareInstanceQuality(a: InstanceRow, b: InstanceRow): number {
  const aLossless = LOSSLESS.has(a.suffix.toLowerCase());
  const bLossless = LOSSLESS.has(b.suffix.toLowerCase());
  return (Number(!!a.missing) - Number(!!b.missing))
    || (Number(bLossless) - Number(aLossless))
    || ((b.bit_depth ?? 0) - (a.bit_depth ?? 0))
    || ((b.sample_rate ?? 0) - (a.sample_rate ?? 0))
    || (aLossless || bLossless ? 0 : (b.bit_rate ?? 0) - (a.bit_rate ?? 0))
    || (formatRank(a.suffix) - formatRank(b.suffix))
    || ((a.created_at ?? Number.MAX_SAFE_INTEGER) - (b.created_at ?? Number.MAX_SAFE_INTEGER))
    || a.id.localeCompare(b.id);
}

export type DataMatch = "match" | "mismatch" | "unknown";
export type FileMode = "exact" | "best";

/** The cached fingerprint identity, or null when absent or stale. */
export function instanceFingerprint(instance: InstanceRow): string | null {
  const parsed = parseFingerprint(instance.source_dedup_key);
  if (!parsed) return null;
  const currentSize = instance.object_size ?? instance.size;
  return currentSize && parsed.size !== currentSize ? null : parsed.identity;
}

export function dataSegmentMatch(instances: InstanceRow[]): DataMatch {
  const primaries = instances.filter(isPrimaryInstance);
  if (primaries.length < 2) return "match";
  const fingerprints = primaries.map(instanceFingerprint);
  if (fingerprints.some((value) => !value)) return "unknown";
  return new Set(fingerprints).size === 1 ? "match" : "mismatch";
}

export function defaultFileMode(match: DataMatch): FileMode {
  return match === "match" ? "best" : "exact";
}

function byteIdentity(instance: InstanceRow): string[] {
  const keys = [instance.storage_object_id ? `object:${instance.storage_object_id}` : `uri:${instance.storage_uri}`];
  const etag = instance.etag?.replace(/"/g, "").trim();
  const size = instance.object_size ?? instance.size;
  if (etag && size) keys.push(`bytes:${instance.suffix.toLowerCase()}:${size}:${etag}`);
  return keys;
}

// Instance ids to remove after a merge. Derived transcodes/caches follow
// their parent inside retireInstance, so only primary copies are planned.
//  - exact: drop copies whose bytes are identical (same object, or same
//    format, size and etag), keeping the best of each identical set;
//  - best: keep only the single best copy.
export function planRetirement(instances: InstanceRow[], mode: FileMode): string[] {
  const primaries = instances.filter((instance) => isPrimaryInstance(instance) && !isVideoInstance(instance)).sort(compareInstanceQuality);
  if (primaries.length < 2 || primaries[0].missing) return [];
  if (mode === "best") return primaries.slice(1).map((instance) => instance.id);

  const keeperByKey = new Map<string, string>();
  const retire: string[] = [];
  for (const instance of primaries) {
    const keys = byteIdentity(instance);
    if (keys.some((key) => keeperByKey.has(key))) {
      retire.push(instance.id);
    } else {
      for (const key of keys) keeperByKey.set(key, instance.id);
    }
  }
  return retire;
}

export interface InstanceView {
  id: string;
  suffix: string;
  size: number | null;
  bitDepth: number | null;
  sampleRate: number | null;
  bitRate: number | null;
  duration: number | null;
  missing: boolean;
  primary: boolean;
  path: string;
  fingerprint: string | null;
  fingerprintable: boolean;
}

function instanceView(snapshot: CatalogSnapshot, instance: InstanceRow): InstanceView {
  return {
    id: instance.id,
    suffix: instance.suffix,
    size: instance.object_size ?? instance.size,
    bitDepth: instance.bit_depth,
    sampleRate: instance.sample_rate,
    bitRate: instance.bit_rate,
    duration: instance.duration,
    missing: !!instance.missing,
    primary: isPrimaryInstance(instance),
    path: snapshot.entryByInstance.get(instance.id)?.path ?? instance.storage_uri,
    fingerprint: instanceFingerprint(instance),
    fingerprintable: instance.storage_uri.startsWith("r2://"),
  };
}

function pendingFingerprints(instances: InstanceRow[]): string[] {
  return instances
    .filter((instance) => isPrimaryInstance(instance) && !instance.missing
      && instance.storage_uri.startsWith("r2://") && !instanceFingerprint(instance))
    .map((instance) => instance.id);
}

// ---------------------------------------------------------------------------
// Duplicate songs
// ---------------------------------------------------------------------------

export interface SongView {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  albumId: string | null;
  albumArtist: string | null;
  track: number | null;
  disc: number | null;
  duration: number | null;
  instances: InstanceView[];
}

function songView(snapshot: CatalogSnapshot, song: SongRow): SongView {
  return {
    id: song.id,
    title: song.title ?? "",
    artist: song.artist_name,
    album: song.album_name,
    albumId: song.album_id,
    albumArtist: song.album_artist_name,
    track: song.track,
    disc: song.disc,
    duration: song.duration,
    instances: (snapshot.instancesByMaster.get(song.id) ?? []).map((instance) => instanceView(snapshot, instance)),
  };
}

export interface DuplicateSongGroup {
  key: string;
  confidence: "exact" | "high" | "medium";
  survivorId: string;
  songs: SongView[];
  dataMatch: DataMatch;
  defaultMode: FileMode;
  pendingFingerprints: string[];
}

// Splits a same-title group into runs whose durations stay within tolerance.
// Songs with unknown duration join only when exactly one run exists.
function clusterByDuration(songs: SongRow[]): SongRow[][] {
  const known = songs.filter((song) => song.duration && song.duration > 0)
    .sort((a, b) => (a.duration ?? 0) - (b.duration ?? 0));
  const unknown = songs.filter((song) => !song.duration || song.duration <= 0);
  const clusters: SongRow[][] = [];
  for (const song of known) {
    const current = clusters.at(-1);
    if (current && (song.duration ?? 0) - (current.at(-1)!.duration ?? 0) <= DURATION_TOLERANCE) current.push(song);
    else clusters.push([song]);
  }
  if (clusters.length === 1) clusters[0].push(...unknown);
  else if (clusters.length === 0 && unknown.length > 1) clusters.push(unknown);
  return clusters.filter((cluster) => cluster.length > 1);
}

function sharesBytes(instances: InstanceRow[]): boolean {
  const seen = new Map<string, string>();
  for (const instance of instances.filter(isPrimaryInstance)) {
    for (const key of byteIdentity(instance)) {
      const owner = seen.get(key);
      if (owner && owner !== instance.master_id) return true;
      seen.set(key, instance.master_id);
    }
  }
  return false;
}

export function findDuplicateSongs(snapshot: CatalogSnapshot): DuplicateSongGroup[] {
  const candidates = snapshot.songs.filter((song) =>
    song.album_id !== PLACEHOLDER_ALBUM && songTitleKey(song.title) && !isObjectTitle(song.title ?? undefined)
    && !isVideoOnlySong(snapshot, song.id));
  const groups: DuplicateSongGroup[] = [];
  for (const [key, songs] of groupBy(candidates, (song) => `${songTitleKey(song.title)}\0${artistKey(song.artist_name)}`)) {
    if (songs.length < 2) continue;
    for (const cluster of clusterByDuration(songs)) {
      // Same title twice inside one album with distinct track numbers is a
      // deliberate reprise, not a duplicate upload.
      const sameAlbum = new Set(cluster.map((song) => song.album_id)).size === 1;
      const positions = cluster.map((song) => `${song.disc ?? 1}:${song.track ?? ""}`);
      if (sameAlbum && cluster.every((song) => song.track !== null) && new Set(positions).size === cluster.length) continue;

      const instances = cluster.flatMap((song) => snapshot.instancesByMaster.get(song.id) ?? []);
      const dataMatch = dataSegmentMatch(instances);
      const sameRelease = new Set(cluster.map((song) => albumTitleKey(song.album_name))).size === 1;
      const confidence = sharesBytes(instances) || (dataMatch === "match" && instances.filter(isPrimaryInstance).length > 1)
        ? "exact"
        : sameRelease ? "high" : "medium";
      const survivor = chooseSurvivorMaster(cluster);
      groups.push({
        key: `${key}\0${survivor.id}`,
        confidence,
        survivorId: survivor.id,
        songs: [survivor, ...cluster.filter((song) => song.id !== survivor.id)].map((song) => songView(snapshot, song)),
        dataMatch,
        defaultMode: defaultFileMode(dataMatch),
        pendingFingerprints: pendingFingerprints(instances),
      });
    }
  }
  const order = { exact: 0, high: 1, medium: 2 };
  return groups.sort((a, b) => order[a.confidence] - order[b.confidence] || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Duplicate albums
// ---------------------------------------------------------------------------

export interface AlbumView {
  id: string;
  name: string;
  albumArtist: string | null;
  songCount: number;
  formats: string[];
  folders: string[];
  year: number | null;
  hasCover: boolean;
}

export interface AlbumSongPair {
  survivorSongId: string;
  duplicateSongId: string;
  title: string;
  dataMatch: DataMatch;
}

export interface DuplicateAlbumGroup {
  key: string;
  survivorId: string;
  albums: AlbumView[];
  pairs: AlbumSongPair[];
  moved: number;
  dataMatch: DataMatch;
  defaultMode: FileMode;
  pendingFingerprints: string[];
}

function dirname(path: string): string {
  const clean = path.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const at = clean.lastIndexOf("/");
  return at >= 0 ? clean.slice(0, at) : "";
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function songAlbumArtist(song: SongRow): string | null {
  return song.album_artist_name ?? song.artist_name;
}

function albumView(snapshot: CatalogSnapshot, album: AlbumRow, songs: SongRow[]): AlbumView {
  const instances = songs.flatMap((song) => snapshot.instancesByMaster.get(song.id) ?? []).filter(isPrimaryInstance);
  return {
    id: album.id,
    name: album.name,
    albumArtist: mostCommon(songs.map(songAlbumArtist)) ?? null,
    songCount: songs.length,
    formats: [...new Set(instances.map((instance) => instance.suffix.toLowerCase()))].sort(),
    folders: [...new Set(instances.map((instance) =>
      dirname(snapshot.entryByInstance.get(instance.id)?.path ?? instance.storage_uri)))].sort().slice(0, 4),
    year: album.year,
    hasCover: !!album.cover_r2_key,
  };
}

/**
 * Pairs each duplicate song with a survivor song of the same title, preferring
 * the same disc/track position. Unpaired duplicates simply move albums.
 */
export function pairAlbumSongs(survivorSongs: SongRow[], duplicateSongs: SongRow[]): { pairs: Array<[SongRow, SongRow]>; unmatched: SongRow[] } {
  const available = new Map<string, SongRow[]>();
  for (const song of survivorSongs) {
    const key = songTitleKey(song.title);
    available.set(key, [...(available.get(key) ?? []), song]);
  }
  const pairs: Array<[SongRow, SongRow]> = [];
  const unmatched: SongRow[] = [];
  for (const duplicate of duplicateSongs) {
    const options = available.get(songTitleKey(duplicate.title)) ?? [];
    // Copies of one release often disagree on artist tags, so the same disc
    // and track position is enough; otherwise the artists must be related.
    const samePosition = (song: SongRow) => song.track !== null && (song.disc ?? 1) === (duplicate.disc ?? 1) && song.track === duplicate.track;
    const closeEnough = options.filter((song) =>
      (!song.duration || !duplicate.duration || Math.abs(song.duration - duplicate.duration) <= DURATION_TOLERANCE)
      && (samePosition(song) || artistsRelated(song.artist_name, duplicate.artist_name)));
    const match = closeEnough.find(samePosition) ?? closeEnough[0];
    if (!match) { unmatched.push(duplicate); continue; }
    options.splice(options.indexOf(match), 1);
    pairs.push([match, duplicate]);
  }
  return { pairs, unmatched };
}

function combineMatches(matches: DataMatch[]): DataMatch {
  if (matches.some((match) => match === "mismatch")) return "mismatch";
  if (matches.some((match) => match === "unknown")) return "unknown";
  return "match";
}

export function findDuplicateAlbums(snapshot: CatalogSnapshot): DuplicateAlbumGroup[] {
  const songsByAlbum = groupBy(snapshot.songs, (song) => song.album_id ?? "");
  const candidates = snapshot.albums.filter((album) =>
    album.id !== PLACEHOLDER_ALBUM && !isGenericAlbumName(album.name) && !isObjectTitle(album.name)
    && (songsByAlbum.get(album.id)?.length ?? 0) > 0);
  const keyOf = (album: AlbumRow) => {
    const songs = songsByAlbum.get(album.id) ?? [];
    return `${albumTitleKey(album.name)}\0${artistKey(mostCommon(songs.map(songAlbumArtist)))}`;
  };

  // Two signals join albums: the same name and dominant album artist, or the
  // same name with a shared track title inside one folder (FLAC and WAV
  // copies whose album-artist tags disagree).
  const parent = new Map(candidates.map((album) => [album.id, album.id]));
  const find = (id: string): string => {
    const root = parent.get(id)!;
    if (root === id) return id;
    const resolved = find(root);
    parent.set(id, resolved);
    return resolved;
  };
  const join = (ids: string[]) => {
    for (const id of ids.slice(1)) parent.set(find(id), find(ids[0]));
  };
  for (const albums of groupBy(candidates, keyOf).values()) join(albums.map((album) => album.id));
  const sharedTracks = new Map<string, Set<string>>();
  for (const album of candidates) {
    for (const song of songsByAlbum.get(album.id)!) {
      const folder = homeFolder(snapshot, song);
      if (!folder || folder.root || isVideoOnlySong(snapshot, song.id)) continue;
      const key = `${folder.key}\0${albumTitleKey(album.name)}\0${songTitleKey(song.title)}`;
      sharedTracks.set(key, (sharedTracks.get(key) ?? new Set()).add(album.id));
    }
  }
  for (const ids of sharedTracks.values()) if (ids.size > 1) join([...ids]);

  const groups: DuplicateAlbumGroup[] = [];
  for (const albums of groupBy(candidates, (album) => find(album.id)).values()) {
    if (albums.length < 2) continue;
    const key = keyOf(albums[0]);
    const ranked = [...albums].sort((a, b) =>
      (songsByAlbum.get(b.id)!.length - songsByAlbum.get(a.id)!.length)
      || (Number(!!b.cover_r2_key) - Number(!!a.cover_r2_key))
      || ((a.created_at ?? Number.MAX_SAFE_INTEGER) - (b.created_at ?? Number.MAX_SAFE_INTEGER))
      || a.id.localeCompare(b.id));
    const survivor = ranked[0];
    const pool = [...songsByAlbum.get(survivor.id)!];
    const pairs: AlbumSongPair[] = [];
    let moved = 0;
    const pending: string[] = [];
    for (const duplicate of ranked.slice(1)) {
      const result = pairAlbumSongs(pool, songsByAlbum.get(duplicate.id)!);
      for (const [kept, merged] of result.pairs) {
        const instances = [kept, merged].flatMap((song) => snapshot.instancesByMaster.get(song.id) ?? []);
        pairs.push({ survivorSongId: kept.id, duplicateSongId: merged.id, title: kept.title ?? "", dataMatch: dataSegmentMatch(instances) });
        pending.push(...pendingFingerprints(instances));
      }
      moved += result.unmatched.length;
      pool.push(...result.unmatched);
    }
    const dataMatch = pairs.length ? combineMatches(pairs.map((pair) => pair.dataMatch)) : "unknown";
    groups.push({
      key,
      survivorId: survivor.id,
      albums: ranked.map((album) => albumView(snapshot, album, songsByAlbum.get(album.id)!)),
      pairs,
      moved,
      dataMatch,
      defaultMode: defaultFileMode(dataMatch),
      pendingFingerprints: [...new Set(pending)],
    });
  }
  return groups.sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Folder album consistency
// ---------------------------------------------------------------------------

export interface FolderTrackCredit {
  /** Current album artist credit, null when the track has none. */
  albumArtist: string | null;
  /** Track artist credit. */
  artist: string;
}

// Every individual artist across the credits, most frequent first (ties keep
// first appearance), joined the way parseAlbumArtistCredit stores them.
function joinCredits(credits: string[]): string | null {
  const names = new Map<string, { name: string; count: number; first: number }>();
  for (const credit of credits) {
    if (!credit.trim()) continue;
    for (const { name } of parseArtistCredits(credit)) {
      const key = artistKey(name);
      const entry = names.get(key);
      if (entry) entry.count++;
      else names.set(key, { name, count: 1, first: names.size });
    }
  }
  if (names.size === 0) return null;
  return [...names.values()].sort((a, b) => b.count - a.count || a.first - b.first).map((entry) => entry.name).join(", ");
}

/**
 * The album artist every track in one folder album should share, or null to
 * leave the folder for manual review instead of rewriting it automatically.
 *  - Tagged credits that differ by at most one artist ("A" and "A, B") unify
 *    to the most common credit; on a tie the fuller credit keeps the extra
 *    artist. Untagged tracks simply adopt it. Wider differences are manual.
 *  - With no album artist anywhere, the album is credited to every track
 *    artist, most frequent first.
 */
export function chooseFolderAlbumArtist(tracks: FolderTrackCredit[]): string | null {
  const tagged = tracks.map((track) => track.albumArtist?.trim() ?? "").filter(Boolean);
  if (tagged.length === 0) return joinCredits(tracks.map((track) => track.artist));

  const sets = tagged.map((credit) => new Set(albumArtistCredits(credit)));
  const union = new Set(sets.flatMap((set) => [...set]));
  const shared = [...union].filter((name) => sets.every((set) => set.has(name)));
  if (union.size - shared.length > 1) return null;

  const counts = new Map<string, { credit: string; count: number; size: number; first: number }>();
  tagged.forEach((credit, index) => {
    const key = albumArtistCredits(credit).join("\0");
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { credit, count: 1, size: sets[index].size, first: index });
  });
  return [...counts.values()].sort((a, b) => b.count - a.count || b.size - a.size || a.first - b.first)[0].credit;
}

export interface TrackPlanInput {
  id: string;
  title: string;
  disc: number | null;
  track: number | null;
  fileName: string;
}

export interface TrackChange {
  songId: string;
  title: string;
  fromDisc: number | null;
  fromTrack: number | null;
  toDisc: number | null;
  toTrack: number;
}

const naturalCompare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

function hasPositionProblem(tracks: TrackPlanInput[]): boolean {
  if (tracks.some((track) => !track.track || track.track <= 0)) return true;
  const positions = tracks.map((track) => `${track.disc ?? 1}:${track.track}`);
  return new Set(positions).size !== positions.length;
}

function orderVocalsThenInstrumentals(tracks: TrackPlanInput[]): TrackPlanInput[] {
  const byPosition = (a: TrackPlanInput, b: TrackPlanInput) =>
    ((a.track ?? Number.MAX_SAFE_INTEGER) - (b.track ?? Number.MAX_SAFE_INTEGER)) || naturalCompare(a.fileName, b.fileName);
  const vocals = tracks.filter((track) => !isInstrumentalTitle(track.title)).sort(byPosition);
  const vocalIndex = new Map<string, number>();
  vocals.forEach((track, index) => {
    const key = songTitleKey(track.title);
    if (!vocalIndex.has(key)) vocalIndex.set(key, index);
  });
  const indexOf = (track: TrackPlanInput) => vocalIndex.get(songTitleKey(instrumentalBaseTitle(track.title))) ?? Number.MAX_SAFE_INTEGER;
  const instrumentals = tracks.filter((track) => isInstrumentalTitle(track.title))
    .sort((a, b) => (indexOf(a) - indexOf(b)) || byPosition(a, b));
  return [...vocals, ...instrumentals];
}

const FILE_POSITION = /^(?:(\d{1,2})\s*[-_.]\s*)?(\d{1,3})(?=[\s._、-]|$)/u;

// Disc/track encoded in "1-03 Title.flac" / "03. Title.flac", when every
// file carries one and together they are unique.
function positionsFromFileNames(tracks: TrackPlanInput[]): Map<string, { disc: number | null; track: number }> | null {
  const positions = new Map<string, { disc: number | null; track: number }>();
  for (const track of tracks) {
    const match = FILE_POSITION.exec(track.fileName.normalize("NFKC"));
    if (!match || Number(match[2]) <= 0) return null;
    positions.set(track.id, { disc: match[1] ? Number(match[1]) : track.disc, track: Number(match[2]) });
  }
  const keys = [...positions.values()].map((position) => `${position.disc ?? 1}:${position.track}`);
  return new Set(keys).size === keys.length ? positions : null;
}

export interface TrackPlan {
  changes: TrackChange[];
  /** Positions are wrong but no rule could place every track safely. */
  unresolved: boolean;
}

// Assigns disc/track numbers when they are missing or collide, preferring the
// smallest change that makes every position unique:
//  1. Vocal and instrumental tracks that are each consistent on their own but
//     collide with each other (a vocal set and its backing-track set both
//     tagged 1..n) keep their numbers; the instrumentals move to the next disc.
//  2. Only some numbers are missing: numbered tracks stay put and the rest are
//     appended per disc, vocals first, instrumentals following the order of
//     the vocal track they accompany.
//  3. Numbered tracks collide among themselves: positions are taken from the
//     file names when those are complete and unique (an untagged two-disc
//     album named "1-01", "2-01"); otherwise the folder needs manual review.
export function planTrackNumbers(tracks: TrackPlanInput[]): TrackPlan {
  if (tracks.length < 2 || !hasPositionProblem(tracks)) return { changes: [], unresolved: false };
  const vocals = tracks.filter((track) => !isInstrumentalTitle(track.title));
  const instrumentals = tracks.filter((track) => isInstrumentalTitle(track.title));
  const numbered = tracks.filter((track) => track.track && track.track > 0);
  let assigned = new Map<string, { disc: number | null; track: number }>();

  if (vocals.length && instrumentals.length && !hasPositionProblem(vocals) && !hasPositionProblem(instrumentals)
    && new Set(instrumentals.map((track) => track.disc ?? 1)).size === 1) {
    const nextDisc = Math.max(...vocals.map((track) => track.disc ?? 1)) + 1;
    for (const track of instrumentals) assigned.set(track.id, { disc: nextDisc, track: track.track! });
  } else if (!hasPositionProblem(numbered)) {
    for (const [disc, discTracks] of groupBy(tracks, (track) => track.disc ?? 1)) {
      let next = Math.max(0, ...discTracks.map((track) => track.track ?? 0));
      const discValue = discTracks.find((track) => track.disc !== null)?.disc ?? (disc === 1 ? null : disc);
      for (const track of orderVocalsThenInstrumentals(discTracks.filter((item) => !item.track || item.track <= 0))) {
        assigned.set(track.id, { disc: track.disc ?? discValue, track: ++next });
      }
    }
  } else {
    const fromNames = positionsFromFileNames(tracks);
    if (!fromNames) return { changes: [], unresolved: true };
    assigned = fromNames;
  }

  const changes: TrackChange[] = [];
  for (const track of tracks) {
    const next = assigned.get(track.id);
    if (!next || (next.disc === track.disc && next.track === track.track)) continue;
    changes.push({
      songId: track.id,
      title: track.title,
      fromDisc: track.disc,
      fromTrack: track.track,
      toDisc: next.disc,
      toTrack: next.track,
    });
  }
  return { changes, unresolved: false };
}

export type FolderProblem = "splitAlbum" | "albumArtist" | "missingAlbumArtist" | "trackNumbers" | "duplicateCopies";

export interface FolderAlbumIssue {
  key: string;
  folder: string;
  albumName: string;
  problems: FolderProblem[];
  albums: Array<{ id: string; name: string; songCount: number }>;
  albumArtists: Array<{ name: string | null; count: number }>;
  proposedAlbumArtist: string | null;
  targetAlbumId: string;
  autoFixable: boolean;
  trackChanges: TrackChange[];
  /** Track positions are wrong but could not be planned automatically. */
  tracksUnresolved: boolean;
  songs: Array<{ id: string; title: string; artist: string | null; albumArtist: string | null; albumId: string | null; disc: number | null; track: number | null; fileName: string }>;
}

// A song belongs to the folder of its best primary copy, so a track whose
// FLAC and WAV live in different folders is only planned once.
// Files directly under a storage root are unrelated uploads, not an album
// folder (`root`), and are left out of folder-based grouping.
function homeFolder(snapshot: CatalogSnapshot, song: SongRow): { key: string; path: string; fileName: string; root: boolean } | null {
  const best = (snapshot.instancesByMaster.get(song.id) ?? []).filter(isPrimaryInstance).sort(compareInstanceQuality)[0];
  if (!best) return null;
  const entry = snapshot.entryByInstance.get(best.id);
  if (entry) {
    return { key: `${entry.source_id}\0${entry.parent_id ?? ""}`, path: dirname(entry.path), fileName: basename(entry.path), root: !entry.parent_id };
  }
  const path = dirname(best.storage_uri);
  return { key: `${best.source_id}\0uri:${path}`, path, fileName: basename(best.storage_uri), root: !path.includes("/") };
}

export function planFolderAlbum(songs: Array<SongRow & { fileName: string }>, snapshot: CatalogSnapshot, folder: { key: string; path: string }): FolderAlbumIssue | null {
  const albumIds = [...new Set(songs.map((song) => song.album_id ?? ""))];
  const credits = songs.map((song) => ({ albumArtist: song.album_artist_name, artist: song.artist_name ?? "" }));
  const albumArtistKeys = new Set(credits.map((credit) => credit.albumArtist ? artistKey(credit.albumArtist) : null));
  const trackArtists = new Set(credits.map((credit) => artistKey(credit.artist)));

  // The same title in two of the folder's albums means copies of one release
  // (a FLAC and a WAV set); that is a duplicate-album merge, not a split.
  const albumsByTitle = groupBy(songs, (song) => songTitleKey(song.title));
  const duplicateCopies = albumIds.length > 1
    && [...albumsByTitle.values()].some((group) => new Set(group.map((song) => song.album_id)).size > 1);

  const problems: FolderProblem[] = [];
  if (duplicateCopies) {
    problems.push("duplicateCopies");
  } else {
    if (albumIds.length > 1) problems.push("splitAlbum");
    if (albumArtistKeys.size > 1) problems.push("albumArtist");
    else if (albumArtistKeys.has(null) && albumIds.length > 1 && trackArtists.size > 1) problems.push("missingAlbumArtist");
  }

  const trackInputs = songs.map((song) => ({ id: song.id, title: song.title ?? "", disc: song.disc, track: song.track, fileName: song.fileName }));
  const trackPlan = duplicateCopies ? { changes: [], unresolved: false } : planTrackNumbers(trackInputs);
  if (trackPlan.changes.length || trackPlan.unresolved) problems.push("trackNumbers");
  if (problems.length === 0) return null;

  const needsArtist = problems.includes("splitAlbum") || problems.includes("albumArtist") || problems.includes("missingAlbumArtist");
  const proposedAlbumArtist = needsArtist ? chooseFolderAlbumArtist(credits) : songs[0].album_artist_name;
  const albumCounts = albumIds.map((id) => ({ id, count: songs.filter((song) => (song.album_id ?? "") === id).length }))
    .sort((a, b) => b.count - a.count
      || ((snapshot.albumsById.get(a.id)?.created_at ?? Number.MAX_SAFE_INTEGER) - (snapshot.albumsById.get(b.id)?.created_at ?? Number.MAX_SAFE_INTEGER))
      || a.id.localeCompare(b.id));
  const artistCounts = new Map<string | null, number>();
  for (const credit of credits) artistCounts.set(credit.albumArtist, (artistCounts.get(credit.albumArtist) ?? 0) + 1);

  return {
    key: `${folder.key}\0${albumTitleKey(songs[0].album_name)}`,
    folder: folder.path,
    albumName: snapshot.albumsById.get(albumCounts[0].id)?.name ?? songs[0].album_name ?? "",
    problems,
    albums: albumCounts.map(({ id, count }) => ({ id, name: snapshot.albumsById.get(id)?.name ?? id, songCount: count })),
    albumArtists: [...artistCounts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    proposedAlbumArtist,
    targetAlbumId: albumCounts[0].id,
    autoFixable: !duplicateCopies && (!needsArtist || proposedAlbumArtist !== null)
      && (needsArtist || trackPlan.changes.length > 0),
    trackChanges: trackPlan.changes,
    tracksUnresolved: trackPlan.unresolved,
    songs: songs.map((song) => ({
      id: song.id,
      title: song.title ?? "",
      artist: song.artist_name,
      albumArtist: song.album_artist_name,
      albumId: song.album_id,
      disc: song.disc,
      track: song.track,
      fileName: song.fileName,
    })),
  };
}

export function findFolderAlbumIssues(snapshot: CatalogSnapshot): FolderAlbumIssue[] {
  const located: Array<SongRow & { fileName: string; folderKey: string; folderPath: string }> = [];
  for (const song of snapshot.songs) {
    if (song.album_id === PLACEHOLDER_ALBUM) continue;
    const folder = homeFolder(snapshot, song);
    if (folder && !folder.root) located.push({ ...song, fileName: folder.fileName, folderKey: folder.key, folderPath: folder.path });
  }
  const issues: FolderAlbumIssue[] = [];
  for (const songs of groupBy(located, (song) => `${song.folderKey}\0${albumTitleKey(song.album_name)}`).values()) {
    const issue = planFolderAlbum(songs, snapshot, { key: songs[0].folderKey, path: songs[0].folderPath });
    if (issue) issues.push(issue);
  }
  return issues.sort((a, b) => naturalCompare(a.folder, b.folder) || naturalCompare(a.albumName, b.albumName));
}

// ---------------------------------------------------------------------------
// Data errors
// ---------------------------------------------------------------------------

export type DataIssueKind =
  | "objectTitle"
  | "garbledTitle"
  | "objectAlbumName"
  | "objectArtistName"
  | "unknownDuration"
  | "implausibleDuration"
  | "ghostSong"
  | "missingFiles"
  | "emptyAlbum"
  | "staleAlbumTotals"
  | "danglingReference";

export type DataFix =
  | { action: "setTitle"; value: string }
  | { action: "setAlbumName"; value: string }
  | { action: "setDuration"; value: number }
  | { action: "reparse"; instanceIds: string[] }
  | { action: "deleteSong" }
  | { action: "deleteAlbum" }
  | { action: "refreshAlbum" };

export interface DataIssue {
  kind: DataIssueKind;
  id: string;
  label: string;
  detail: string;
  fix: DataFix | null;
}

function logicalPaths(snapshot: CatalogSnapshot, songId: string): string[] {
  return (snapshot.instancesByMaster.get(songId) ?? [])
    .map((instance) => snapshot.entryByInstance.get(instance.id)?.path)
    .filter((path): path is string => !!path);
}

function titleFix(snapshot: CatalogSnapshot, song: SongRow): DataFix | null {
  for (const path of logicalPaths(snapshot, song.id)) {
    if (!canRecoverLogicalTrackTitle(path, song.title ?? undefined)) continue;
    const title = recoverMetadataFromLogicalPath(path, { title: song.title ?? undefined }).title;
    if (title && title !== song.title) return { action: "setTitle", value: title };
  }
  return null;
}

function reparseCandidates(snapshot: CatalogSnapshot, songId: string): string[] {
  return (snapshot.instancesByMaster.get(songId) ?? [])
    .filter((instance) => isPrimaryInstance(instance) && !instance.missing)
    .map((instance) => instance.id);
}

export function planSongIssues(snapshot: CatalogSnapshot, song: SongRow): DataIssue[] {
  const issues: DataIssue[] = [];
  const label = `${song.title ?? ""} — ${song.artist_name ?? "?"}`;
  const instances = snapshot.instancesByMaster.get(song.id) ?? [];
  const primaries = instances.filter(isPrimaryInstance);

  if (isObjectTitle(song.title ?? undefined)) {
    issues.push({ kind: "objectTitle", id: song.id, label, detail: song.title ?? "", fix: titleFix(snapshot, song) });
  } else if (looksLossy(song.title ?? undefined)) {
    issues.push({ kind: "garbledTitle", id: song.id, label, detail: song.title ?? "", fix: titleFix(snapshot, song) });
  }
  if (!song.album_name || (song.artist_id && song.artist_name === null)) {
    issues.push({ kind: "danglingReference", id: song.id, label, detail: !song.album_name ? `album ${song.album_id}` : `artist ${song.artist_id}`, fix: null });
  }
  if (instances.length === 0) {
    issues.push({ kind: "ghostSong", id: song.id, label, detail: "", fix: { action: "deleteSong" } });
    return issues;
  }
  if (primaries.length > 0 && primaries.every((instance) => instance.missing)) {
    issues.push({ kind: "missingFiles", id: song.id, label, detail: primaries.map((instance) => instance.suffix).join(", "), fix: null });
  }

  const bestDuration = Math.max(0, ...primaries.filter((instance) => !instance.missing).map((instance) => instance.duration ?? 0));
  if (!song.duration || song.duration <= 0) {
    const reparse = reparseCandidates(snapshot, song.id);
    issues.push({
      kind: "unknownDuration",
      id: song.id,
      label,
      detail: "",
      fix: bestDuration > 0 ? { action: "setDuration", value: bestDuration } : reparse.length ? { action: "reparse", instanceIds: reparse } : null,
    });
  } else {
    // A WAV of several MB that "lasts" under ten seconds is an old
    // truncated-buffer parse; a master far from every copy is stale.
    const songDuration = song.duration;
    const truncatedWav = primaries.some((instance) => instance.suffix.toLowerCase() === "wav" && !instance.missing
      && (instance.object_size ?? instance.size ?? 0) > 5 * 1024 * 1024 && (instance.duration ?? songDuration) < 10);
    const knownCopies = primaries.filter((instance) => !instance.missing && instance.duration && instance.duration > 0);
    const drifted = knownCopies.length > 0 && knownCopies.every((instance) => Math.abs((instance.duration ?? 0) - songDuration) > 5);
    if (truncatedWav) {
      issues.push({ kind: "implausibleDuration", id: song.id, label, detail: `${song.duration}s`, fix: { action: "reparse", instanceIds: reparseCandidates(snapshot, song.id) } });
    } else if (drifted) {
      issues.push({ kind: "implausibleDuration", id: song.id, label, detail: `${song.duration}s → ${bestDuration}s`, fix: { action: "setDuration", value: bestDuration } });
    }
  }
  return issues;
}

export function planAlbumIssues(snapshot: CatalogSnapshot, album: AlbumRow, songs: SongRow[]): DataIssue[] {
  if (album.id === PLACEHOLDER_ALBUM) return [];
  if (songs.length === 0) return [{ kind: "emptyAlbum", id: album.id, label: album.name, detail: "", fix: { action: "deleteAlbum" } }];
  const issues: DataIssue[] = [];
  if (isObjectTitle(album.name)) {
    const name = songs.flatMap((song) => logicalPaths(snapshot, song.id)).map(albumNameFromSourcePath).find((value) => !!value);
    issues.push({ kind: "objectAlbumName", id: album.id, label: album.name, detail: "", fix: name ? { action: "setAlbumName", value: name } : null });
  }
  const duration = songs.reduce((total, song) => total + (song.duration ?? 0), 0);
  const size = songs.reduce((total, song) =>
    total + (snapshot.instancesByMaster.get(song.id) ?? []).reduce((sum, instance) => sum + (instance.size ?? 0), 0), 0);
  if ((album.song_count ?? 0) !== songs.length || (album.duration ?? 0) !== duration || (album.size ?? 0) !== size) {
    issues.push({
      kind: "staleAlbumTotals",
      id: album.id,
      label: album.name,
      detail: `${album.song_count ?? 0} / ${album.duration ?? 0}s / ${album.size ?? 0}B → ${songs.length} / ${duration}s / ${size}B`,
      fix: { action: "refreshAlbum" },
    });
  }
  return issues;
}

export function findDataIssues(snapshot: CatalogSnapshot): DataIssue[] {
  const issues = snapshot.songs.filter((song) => song.album_id !== PLACEHOLDER_ALBUM).flatMap((song) => planSongIssues(snapshot, song));
  const songsByAlbum = groupBy(snapshot.songs, (song) => song.album_id ?? "");
  for (const album of snapshot.albums) issues.push(...planAlbumIssues(snapshot, album, songsByAlbum.get(album.id) ?? []));
  for (const artist of snapshot.objectArtists) {
    issues.push({ kind: "objectArtistName", id: artist.id, label: artist.name, detail: "", fix: null });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface DiagnosticsReport {
  generatedAt: number;
  totals: { songs: number; albums: number; folders: number; errors: number };
  songs: DuplicateSongGroup[];
  albums: DuplicateAlbumGroup[];
  folders: FolderAlbumIssue[];
  errors: DataIssue[];
}

export function buildDiagnosticsReport(snapshot: CatalogSnapshot, now = Math.floor(Date.now() / 1000)): DiagnosticsReport {
  const songs = findDuplicateSongs(snapshot);
  const albums = findDuplicateAlbums(snapshot);
  const folders = findFolderAlbumIssues(snapshot);
  const errors = findDataIssues(snapshot);
  return {
    generatedAt: now,
    totals: { songs: songs.length, albums: albums.length, folders: folders.length, errors: errors.length },
    songs: songs.slice(0, REPORT_LIMIT),
    albums: albums.slice(0, REPORT_LIMIT),
    folders: folders.slice(0, REPORT_LIMIT),
    errors: errors.slice(0, REPORT_LIMIT * 4),
  };
}
