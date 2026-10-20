// SPDX-License-Identifier: AGPL-3.0-or-later
// Library diagnostics: pure planners plus a real-schema SQLite run of the
// scan, fingerprint, album merge, file retirement and error-fix routes.
// Run: pnpm exec tsx test/internal/library_diagnostics.test.ts

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { diagnosticsRoutes } from "../../worker/src/endpoints/edgesonic/diagnostics";
import { instrumentalBaseTitle, isInstrumentalTitle } from "../../shared/instrumental";
import { locateAudioSegment } from "../../worker/src/utils/audioFingerprint";
import {
  buildDiagnosticsReport,
  chooseFolderAlbumArtist,
  loadCatalogSnapshot,
  planRetirement,
  planTrackNumbers,
  songTitleKey,
  type InstanceRow,
} from "../../worker/src/utils/libraryDiagnostics";

let failures = 0;
function assert(value: unknown, message: string) {
  if (value) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

// --- Workers runtime shims ---------------------------------------------------

class NodeDigestStream extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>;
  constructor(algorithm: string) {
    const hash = createHash(algorithm.toLowerCase());
    let resolve!: (value: ArrayBuffer) => void;
    const digest = new Promise<ArrayBuffer>((done) => { resolve = done; });
    super({
      write(chunk) { hash.update(chunk); },
      close() { const bytes = hash.digest(); resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)); },
    });
    this.digest = digest;
  }
}
(globalThis.crypto as unknown as { DigestStream: typeof NodeDigestStream }).DigestStream = NodeDigestStream;

function d1(sqlite: DatabaseSync): any {
  function prepare(sql: string) {
    const statement = sqlite.prepare(sql);
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) {
        args = values.map((value) => value === undefined ? null : typeof value === "boolean" ? (value ? 1 : 0) : value);
        return this;
      },
      async first<T = unknown>() { return (statement.get(...args as never[]) ?? null) as T | null; },
      async all<T = unknown>() { return { results: statement.all(...args as never[]) as T[], success: true, meta: {} }; },
      async run() { const result = statement.run(...args as never[]); return { success: true, meta: { changes: Number(result.changes ?? 0) } }; },
    };
  }
  return {
    prepare,
    async batch(items: Array<{ run: () => Promise<unknown> }>) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const item of items) results.push(await item.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function fakeBucket(objects: Map<string, Uint8Array>, deleted: string[]) {
  return {
    async head(key: string) { const bytes = objects.get(key); return bytes ? { size: bytes.length } : null; },
    async get(key: string, options?: { range?: { offset?: number; length?: number } }) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      const offset = options?.range?.offset ?? 0;
      const slice = bytes.slice(offset, offset + (options?.range?.length ?? bytes.length - offset));
      return { body: new Blob([slice]).stream(), arrayBuffer: async () => slice.buffer };
    },
    async delete(key: string) { deleted.push(key); objects.delete(key); },
  };
}

// --- synthetic audio ----------------------------------------------------------

const pcm = (seed: number) => Uint8Array.from({ length: 4096 }, (_, i) => (i * 31 + seed) & 0xff);
const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest();

function flacFile(samples: Uint8Array): Uint8Array {
  const out = new Uint8Array(64 + 512);
  out.set([0x66, 0x4c, 0x61, 0x43], 0); // fLaC
  out.set([0x80, 0x00, 0x00, 0x22], 4); // last block, STREAMINFO, 34 bytes
  out.set(md5(samples), 26);
  return out;
}

function wavFile(samples: Uint8Array, listBytes = 0): Uint8Array {
  const fmt = new Uint8Array(24);
  const view = new DataView(fmt.buffer);
  fmt.set([0x66, 0x6d, 0x74, 0x20]);
  view.setUint32(4, 16, true);
  view.setUint16(8, 1, true); // PCM
  view.setUint16(10, 2, true); // channels
  view.setUint32(12, 44100, true);
  view.setUint32(16, 44100 * 4, true);
  view.setUint16(20, 4, true); // block align
  view.setUint16(22, 16, true); // bits
  const list = new Uint8Array(listBytes ? 8 + listBytes : 0);
  if (listBytes) { list.set([0x4c, 0x49, 0x53, 0x54]); new DataView(list.buffer).setUint32(4, listBytes, true); }
  const dataHeader = new Uint8Array(8);
  dataHeader.set([0x64, 0x61, 0x74, 0x61]);
  new DataView(dataHeader.buffer).setUint32(4, samples.length, true);
  const body = [fmt, list, dataHeader, samples];
  const total = 12 + body.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  out.set([0x52, 0x49, 0x46, 0x46]);
  new DataView(out.buffer).setUint32(4, total - 8, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8);
  let at = 12;
  for (const part of body) { out.set(part, at); at += part.length; }
  return out;
}

const reader = (bytes: Uint8Array) => async (offset: number, length: number) => bytes.slice(offset, offset + length);

// --- pure planners ------------------------------------------------------------

async function pureChecks() {
  console.log("title keys and instrumental pairing:");
  assert(songTitleKey("01. Same Song") === songTitleKey("Same Song"), "track number prefix is ignored");
  assert(songTitleKey("Same Song (Inst.)") !== songTitleKey("Same Song"), "instrumental marker keeps titles apart");
  assert(isInstrumentalTitle("曲名 (Instrumental)") && instrumentalBaseTitle("曲名 (Instrumental)") === "曲名", "bracketed marker is stripped");
  assert(instrumentalBaseTitle("曲名 - inst.") === "曲名", "appended marker and separator are stripped");
  assert(instrumentalBaseTitle("Instrumental Analysis") === "Instrumental Analysis", "marker word inside a title is kept");

  console.log("folder album artist:");
  const credit = (albumArtist: string | null, artist = "X") => ({ albumArtist, artist });
  assert(chooseFolderAlbumArtist([credit("Singer A"), credit("Singer A"), credit("Singer A, Singer B")]) === "Singer A", "credits one artist apart unify to the most common");
  assert(chooseFolderAlbumArtist([credit("Singer A"), credit("Singer A, Singer B")]) === "Singer A, Singer B", "a tie keeps the fuller credit");
  assert(chooseFolderAlbumArtist([credit("singer a "), credit("Singer A")]) !== null, "case and spacing are not a difference");
  assert(chooseFolderAlbumArtist([credit("Singer A"), credit("Singer B")]) === null, "different artists are left for review");
  assert(chooseFolderAlbumArtist([credit("A, B"), credit("A, C")]) === null, "two differing artists are left for review");
  assert(chooseFolderAlbumArtist([credit("Singer A"), credit(null)]) === "Singer A", "untagged tracks adopt the tagged credit");
  assert(chooseFolderAlbumArtist([credit(null, "A, C"), credit(null, "B"), credit(null, "A")]) === "A, C, B", "untagged folders credit every track artist, most frequent first");
  assert(chooseFolderAlbumArtist([credit(null, ""), credit(null, " ")]) === null, "no artist at all yields no credit");

  console.log("track planning:");
  const pairs = planTrackNumbers([
    { id: "a", title: "A", disc: null, track: 1, fileName: "01 A.flac" },
    { id: "b", title: "B", disc: null, track: 2, fileName: "02 B.flac" },
    { id: "ai", title: "A (Inst.)", disc: null, track: 1, fileName: "01 A (Inst.).flac" },
    { id: "bi", title: "B (Inst.)", disc: null, track: 2, fileName: "02 B (Inst.).flac" },
  ]);
  assert(!pairs.unresolved && pairs.changes.length === 2, "vocal/instrumental collision changes only the instrumentals");
  assert(pairs.changes.every((change) => change.toDisc === 2 && change.toTrack === change.fromTrack), "instrumentals move to disc 2 keeping their numbers");

  const gaps = planTrackNumbers([
    { id: "a", title: "A", disc: null, track: 1, fileName: "A.flac" },
    { id: "b", title: "B", disc: null, track: 2, fileName: "B.flac" },
    { id: "ci", title: "C (伴奏)", disc: null, track: null, fileName: "C 伴奏.flac" },
    { id: "c", title: "C", disc: null, track: null, fileName: "C.flac" },
  ]);
  const gapTo = Object.fromEntries(gaps.changes.map((change) => [change.songId, change.toTrack]));
  assert(gaps.changes.length === 2 && gapTo.c === 3 && gapTo.ci === 4, "missing numbers are appended, vocal before its instrumental");

  const discs = planTrackNumbers([
    { id: "x", title: "X", disc: null, track: 1, fileName: "1-01 X.flac" },
    { id: "y", title: "Y", disc: null, track: 1, fileName: "2-01 Y.flac" },
  ]);
  assert(discs.changes.some((change) => change.songId === "y" && change.toDisc === 2 && change.toTrack === 1), "colliding numbers take disc/track from file names");
  const stuck = planTrackNumbers([
    { id: "x", title: "X", disc: null, track: 1, fileName: "X.flac" },
    { id: "y", title: "Y", disc: null, track: 1, fileName: "Y.flac" },
  ]);
  assert(stuck.unresolved && stuck.changes.length === 0, "unplaceable collisions are left for manual review");

  console.log("retirement planning:");
  const copy = (id: string, suffix: string, extra: Partial<InstanceRow> = {}): InstanceRow => ({
    id, master_id: "m", source_id: "r2-local", source_type: "original", parent_instance_id: null,
    storage_uri: `r2://objects/${id}.${suffix}`, storage_object_id: id, suffix, bit_rate: suffix === "mp3" ? 320 : 900,
    sample_rate: 44100, bit_depth: suffix === "mp3" ? null : 16, duration: 200, size: 1000, missing: 0,
    source_dedup_key: null, created_at: 1, etag: null, object_size: 1000, ...extra,
  });
  assert(planRetirement([copy("f", "flac"), copy("m", "mp3")], "exact").length === 0, "exact keeps distinct files");
  assert(planRetirement([copy("f1", "flac", { etag: "e" }), copy("f2", "flac", { etag: "e", created_at: 2 })], "exact").join() === "f2", "exact removes the byte-identical copy");
  assert(planRetirement([copy("m", "mp3"), copy("f", "flac")], "best").join() === "m", "best keeps the lossless copy");
  assert(planRetirement([copy("w", "wav", { bit_rate: 1411 }), copy("f", "flac")], "best").join() === "w", "equal lossless quality prefers FLAC over WAV");
  assert(planRetirement([copy("f", "flac", { missing: 1 }), copy("m", "mp3", { missing: 1 })], "best").length === 0, "nothing is removed when every copy is missing");

  console.log("data segments:");
  const samples = pcm(7);
  const flac = await locateAudioSegment(reader(flacFile(samples)), "flac", 576);
  assert(flac && "md5" in flac && flac.md5 === md5(samples).toString("hex"), "FLAC signature is read from STREAMINFO");
  const wavBytes = wavFile(samples, 70000);
  const wav = await locateAudioSegment(reader(wavBytes), "wav", wavBytes.length);
  assert(wav && "start" in wav && wav.kind === "pcm" && md5(wavBytes.slice(wav.start, wav.end)).equals(md5(samples)), "WAV data chunk behind a large LIST chunk is located");
  const mp3 = new Uint8Array(1000);
  mp3.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 90]);
  mp3.set([0x54, 0x41, 0x47], 1000 - 128);
  const frames = await locateAudioSegment(reader(mp3), "mp3", mp3.length);
  assert(frames && "start" in frames && frames.start === 100 && frames.end === 872, "MP3 frames exclude ID3v2 and ID3v1 tags");
}

// --- real schema run ----------------------------------------------------------

function buildDb(objects: Map<string, Uint8Array>): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(resolve(__dirname, "../../worker/migrations/Schema.sql"), "utf8"));
  db.exec(`
    INSERT INTO users (username, master_password, level) VALUES ('admin', 'x', 3);
    INSERT INTO storage_sources (id, type, base_url) VALUES ('r2-local', 'r2', '');
    INSERT INTO artists (id, name) VALUES ('ar-a', 'Singer A'), ('ar-b', 'Singer B'), ('ar-ab', 'Singer A, Singer B');
    INSERT INTO albums (id, name, created_at) VALUES ('al-flac', 'Album X', 1), ('al-wav', 'Album X', 2),
      ('al-y', 'Album Y', 3), ('al-empty', 'Nothing', 4),
      ('al-z1', 'Album Z', 5), ('al-z2', 'Album Z', 6), ('al-v1', 'Album V', 7), ('al-v2', 'Album V', 8);
    INSERT INTO album_display_groups (id, display_name) VALUES ('g1', 'Album X');
    INSERT INTO album_display_group_members (group_id, album_id, sort_order) VALUES ('g1', 'al-flac', 0), ('g1', 'al-wav', 1);
    INSERT INTO song_masters (id, album_id, artist_id, album_artist_id, title, track, disc, duration, created_at) VALUES
      ('s-f1', 'al-flac', 'ar-a', 'ar-a', 'Song One', 1, 1, 200, 1),
      ('s-f2', 'al-flac', 'ar-a', 'ar-a', 'Song Two', 2, 1, 180, 1),
      ('s-w1', 'al-wav', 'ar-a', NULL, 'Song One', 1, 1, 200, 2),
      ('s-w2', 'al-wav', 'ar-a', NULL, 'Song Two', 2, 1, 180, 2),
      ('s-obj', 'al-y', 'ar-b', 'ar-b', 'obj_0123456789abcdef', 3, NULL, 150, 3),
      ('s-nodur', 'al-y', 'ar-b', 'ar-b', 'No Duration', 4, NULL, NULL, 3),
      ('z1', 'al-z1', 'ar-a', 'ar-a', 'Zeta One', 1, NULL, 100, 5),
      ('z2', 'al-z1', 'ar-a', 'ar-a', 'Zeta Two', 2, NULL, 100, 5),
      ('z3', 'al-z2', 'ar-b', 'ar-ab', 'Zeta Three', 3, NULL, 100, 6),
      ('v1', 'al-v1', 'ar-a', NULL, 'Vee One', 1, NULL, 100, 7),
      ('v2', 'al-v2', 'ar-b', NULL, 'Vee Two', 2, NULL, 100, 8);
    INSERT INTO annotations (user_id, item_id, item_type, starred, starred_at) VALUES ('admin', 's-w1', 'song', 1, 50);
    INSERT INTO play_queues (user_id, song_ids, current_id) VALUES ('admin', '["s-w2","s-f1"]', 's-w2');
    INSERT INTO storage_entries (id, source_id, parent_id, path, display_name, kind) VALUES
      ('d-x', 'r2-local', NULL, 'Album X', 'Album X', 'folder'),
      ('d-y', 'r2-local', NULL, 'Album Y', 'Album Y', 'folder'),
      ('d-z', 'r2-local', NULL, 'Album Z', 'Album Z', 'folder'),
      ('d-v', 'r2-local', NULL, 'Album V', 'Album V', 'folder');
  `);
  const files: Array<[string, string, string, string, Uint8Array, string, number]> = [
    ["i-f1", "s-f1", "obj_f1", "01 Song One.flac", flacFile(pcm(1)), "d-x", 200],
    ["i-f2", "s-f2", "obj_f2", "02 Song Two.flac", flacFile(pcm(2)), "d-x", 180],
    ["i-w1", "s-w1", "obj_w1", "01 Song One.wav", wavFile(pcm(1)), "d-x", 200],
    ["i-w2", "s-w2", "obj_w2", "02 Song Two.wav", wavFile(pcm(2)), "d-x", 180],
    ["i-obj", "s-obj", "obj_o1", "03 Real Title.mp3", new Uint8Array(400), "d-y", 150],
    ["i-nodur", "s-nodur", "obj_n1", "04 No Duration.mp3", new Uint8Array(400), "d-y", 123],
    ["i-z1", "z1", "obj_z1", "01 Zeta One.mp3", new Uint8Array(300), "d-z", 100],
    ["i-z2", "z2", "obj_z2", "02 Zeta Two.mp3", new Uint8Array(301), "d-z", 100],
    ["i-z3", "z3", "obj_z3", "03 Zeta Three.mp3", new Uint8Array(302), "d-z", 100],
    ["i-v1", "v1", "obj_v1", "01 Vee One.mp3", new Uint8Array(303), "d-v", 100],
    ["i-v2", "v2", "obj_v2", "02 Vee Two.mp3", new Uint8Array(304), "d-v", 100],
  ];
  for (const [instanceId, masterId, objectId, name, bytes, folder, duration] of files) {
    const suffix = name.split(".").at(-1)!;
    const key = `objects/${objectId}.${suffix}`;
    objects.set(key, bytes);
    db.prepare("INSERT INTO storage_objects (id, physical_key, suffix, size) VALUES (?, ?, ?, ?)").run(objectId, key, suffix, bytes.length);
    db.prepare(`INSERT INTO song_instances (id, master_id, source_id, storage_uri, storage_object_id, suffix, bit_rate, sample_rate, bit_depth, duration, size)
      VALUES (?, ?, 'r2-local', ?, ?, ?, ?, 44100, ?, ?, ?)`)
      .run(instanceId, masterId, `r2://${key}`, objectId, suffix, suffix === "wav" ? 1411 : 900, suffix === "mp3" ? null : 16, duration, bytes.length);
    const folderPath = ({ "d-x": "Album X", "d-y": "Album Y", "d-z": "Album Z", "d-v": "Album V" } as Record<string, string>)[folder];
    db.prepare(`INSERT INTO storage_entries (id, source_id, parent_id, path, display_name, kind, object_id, instance_id)
      VALUES (?, 'r2-local', ?, ?, ?, 'file', ?, ?)`).run(`e-${instanceId}`, folder, `${folderPath}/${name}`, name, objectId, instanceId);
  }
  return db;
}

async function routeChecks() {
  const objects = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  const sqlite = buildDb(objects);
  const env = { DB: d1(sqlite), MUSIC_BUCKET: fakeBucket(objects, deleted) };
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => { c.set("user", { username: "admin", level: 3, enabled: 1 }); return next(); });
  app.route("/", diagnosticsRoutes);
  const call = async (path: string, body?: unknown) => {
    const response = await app.request(path, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, env);
    return { status: response.status, data: await response.json() as any };
  };
  const row = <T>(sql: string, ...args: unknown[]) => sqlite.prepare(sql).get(...args as never[]) as T;

  console.log("scan:");
  const report = buildDiagnosticsReport(await loadCatalogSnapshot(env.DB));
  const albumGroup = report.albums[0];
  assert(report.albums.length === 1 && albumGroup.albums.length === 2, "FLAC and WAV copies in one folder form one duplicate-album group");
  assert(albumGroup.survivorId === "al-flac" && albumGroup.pairs.length === 2 && albumGroup.moved === 0, "older album survives and both songs pair");
  assert(albumGroup.dataMatch === "unknown" && albumGroup.pendingFingerprints.length === 4, "data segments start unchecked");
  const folder = report.folders.find((issue) => issue.folder === "Album X");
  assert(folder?.problems.includes("duplicateCopies") && !folder.autoFixable, "the folder view defers copies to the album merge");
  const kinds = new Set(report.errors.map((issue) => `${issue.kind}:${issue.id}`));
  assert(kinds.has("objectTitle:s-obj") && kinds.has("unknownDuration:s-nodur") && kinds.has("emptyAlbum:al-empty"), "object title, unknown duration and empty album are reported");

  console.log("fingerprints:");
  const printed = await call("/diagnostics/fingerprint", { instanceIds: albumGroup.pendingFingerprints });
  const identity = Object.fromEntries(printed.data.results.map((result: any) => [result.id, result.fingerprint]));
  assert(identity["i-f1"] && identity["i-f1"] === identity["i-w1"], "FLAC signature equals the matching WAV data MD5");
  assert(identity["i-f2"] !== identity["i-f1"], "different recordings differ");
  const rescanned = buildDiagnosticsReport(await loadCatalogSnapshot(env.DB));
  assert(rescanned.albums[0].dataMatch === "match" && rescanned.albums[0].defaultMode === "best", "cached fingerprints make best the default");

  console.log("album merge:");
  const merged = await call("/diagnostics/albums/merge", { survivorId: "al-flac", albumIds: ["al-wav"], mode: "auto" });
  assert(merged.status === 200 && merged.data.songs.length === 2 && merged.data.songs.every((song: any) => song.mode === "best" && song.retire === 1), "auto resolves to best for matching pairs");
  assert(!row("SELECT id FROM albums WHERE id = 'al-wav'"), "duplicate album is removed");
  assert(!row("SELECT id FROM album_display_groups WHERE id = 'g1'") && !row("SELECT album_id FROM album_display_group_members"), "two-member display group is dissolved without leftovers");
  assert(row<{ n: number }>("SELECT COUNT(*) AS n FROM song_masters WHERE album_id = 'al-flac'").n === 2, "merged album keeps two songs");
  assert(row<{ starred: number }>("SELECT starred FROM annotations WHERE item_id = 's-f1'")?.starred === 1, "star moves to the surviving song");
  const queue = row<{ song_ids: string; current_id: string }>("SELECT song_ids, current_id FROM play_queues WHERE user_id = 'admin'");
  assert(queue.song_ids === '["s-f2","s-f1"]' && queue.current_id === "s-f2", "saved play queue points at survivors");

  console.log("file retirement:");
  for (const song of merged.data.songs) await call("/diagnostics/songs/retire", { songId: song.songId, mode: song.mode });
  assert(deleted.sort().join() === "objects/obj_w1.wav,objects/obj_w2.wav", "only the WAV objects are deleted from storage");
  assert(!row("SELECT id FROM song_instances WHERE id = 'i-w1'") && row("SELECT id FROM song_instances WHERE id = 'i-f1'"), "WAV instance rows go, FLAC stays");
  assert(!row("SELECT id FROM storage_entries WHERE id = 'e-i-w1'") && !row("SELECT id FROM storage_objects WHERE id = 'obj_w1'"), "logical entry and object row of the WAV are removed");
  const totals = row<{ song_count: number; size: number }>("SELECT song_count, size FROM albums WHERE id = 'al-flac'");
  assert(totals.song_count === 2 && totals.size === 576 * 2, "album totals reflect the remaining files");

  console.log("error fixes:");
  await call("/diagnostics/errors/fix", { kind: "objectTitle", ids: ["s-obj"] });
  assert(row<{ title: string }>("SELECT title FROM song_masters WHERE id = 's-obj'").title === "Real Title", "object-key title is restored from the logical file name");
  await call("/diagnostics/errors/fix", { kind: "unknownDuration", ids: ["s-nodur"] });
  assert(row<{ duration: number }>("SELECT duration FROM song_masters WHERE id = 's-nodur'").duration === 123, "unknown duration takes the file duration");
  await call("/diagnostics/errors/fix", { kind: "emptyAlbum", ids: ["al-empty"] });
  assert(!row("SELECT id FROM albums WHERE id = 'al-empty'"), "empty album is deleted");
  const again = await call("/diagnostics/errors/fix", { kind: "emptyAlbum", ids: ["al-empty"] });
  assert(again.data.fixed === 0 && again.data.items[0].error === "Already resolved", "repeating a fix is a no-op");

  console.log("folder fixes:");
  const zeta = report.folders.find((issue) => issue.folder === "Album Z");
  assert(zeta?.problems.includes("splitAlbum") && zeta.problems.includes("albumArtist") && zeta.proposedAlbumArtist === "Singer A" && zeta.autoFixable,
    "folder split by a one-artist difference proposes the majority credit");
  const zetaFix = await call("/diagnostics/folders/fix", { songIds: zeta!.songs.map((song) => song.id) });
  const zetaRows = sqlite.prepare("SELECT sm.album_id, ar.name FROM song_masters sm JOIN artists ar ON ar.id = sm.album_artist_id WHERE sm.id IN ('z1', 'z2', 'z3')").all() as Array<{ album_id: string; name: string }>;
  assert(zetaFix.status === 200 && zetaRows.every((r) => r.album_id === "al-z1" && r.name === "Singer A"), "all tracks join one album with the unified album artist");
  assert(!row("SELECT id FROM albums WHERE id = 'al-z2'"), "the emptied split album is removed");
  const vee = report.folders.find((issue) => issue.folder === "Album V");
  assert(vee?.problems.includes("missingAlbumArtist") && vee.proposedAlbumArtist === "Singer A, Singer B", "untagged split folder proposes every track artist");
  await call("/diagnostics/folders/fix", { songIds: vee!.songs.map((song) => song.id) });
  const veeAlbum = row<{ compilation: number; song_count: number }>("SELECT compilation, song_count FROM albums WHERE id = 'al-v1'");
  assert(veeAlbum.song_count === 2 && veeAlbum.compilation === 1, "untagged folder becomes one compilation album");
  const replay = await call("/diagnostics/folders/fix", { songIds: zeta!.songs.map((song) => song.id) });
  assert(replay.status === 409, "a fixed folder is not applied twice");

  console.log("guards:");
  const stale = await call("/diagnostics/songs/merge", { survivorId: "s-w1", songIds: ["s-f1"], mode: "exact" });
  assert(stale.status === 409, "merging into a song that no longer exists is refused");
  const unknownKind = await call("/diagnostics/errors/fix", { kind: "missingFiles", ids: ["s-f1"] });
  assert(unknownKind.status === 400, "report-only kinds cannot be fixed");
}

(async () => {
  await pureChecks();
  await routeChecks();
  if (failures > 0) {
    console.error(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nALL PASS");
})();
