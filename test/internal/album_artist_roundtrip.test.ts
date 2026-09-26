// SPDX-License-Identifier: AGPL-3.0-or-later
// Real SQLite-backed tag write and Subsonic read round-trip.
// Run: npx tsx test/internal/album_artist_roundtrip.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { tagEditRoutes } from "../../worker/src/endpoints/tag/write";
import { tagReadRoutes } from "../../worker/src/endpoints/tag/read";
import { subsonicRoutes } from "../../worker/src/endpoints/subsonic";
import { createQueries } from "../../worker/src/db/queries";
import { applyMetadataResult } from "../../worker/src/utils/metadataApply";
import { md5 } from "../../worker/src/utils/md5";

let failures = 0;
function assert(value: unknown, message: string) {
  if (value) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

function d1(sqlite: DatabaseSync): any {
  function prepare(sql: string) {
    const statement = sqlite.prepare(sql);
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) {
        args = values.map((value) => value === undefined ? null : typeof value === "boolean" ? (value ? 1 : 0) : value);
        return this;
      },
      async first<T = unknown>() { return (statement.get(...args) ?? null) as T | null; },
      async all<T = unknown>() { return { results: statement.all(...args) as T[], success: true, meta: {} }; },
      async run() { const result = statement.run(...args); return { success: true, meta: { changes: Number(result.changes ?? 0) } }; },
    };
  }
  return { prepare, batch: async (items: Array<{ run: () => Promise<unknown> }>) => Promise.all(items.map((item) => item.run())) };
}

function buildDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, image_r2_key TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, year INTEGER, genre TEXT, cover_r2_key TEXT, song_count INTEGER DEFAULT 0, duration INTEGER DEFAULT 0, size INTEGER DEFAULT 0, compilation INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE song_masters (id TEXT PRIMARY KEY, album_id TEXT NOT NULL, artist_id TEXT NOT NULL, album_artist_id TEXT, title TEXT NOT NULL, sort_title TEXT, track INTEGER, disc INTEGER, duration INTEGER, genre TEXT, compilation INTEGER DEFAULT 0, participants TEXT, lyrics TEXT, lyrics_rich TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE song_artists (song_id TEXT, artist_id TEXT, position INTEGER DEFAULT 0, PRIMARY KEY(song_id, artist_id));
    CREATE TABLE song_instances (id TEXT PRIMARY KEY, master_id TEXT, source_id TEXT, source_type TEXT DEFAULT 'original', storage_uri TEXT, suffix TEXT, content_type TEXT, size INTEGER DEFAULT 0, bit_rate INTEGER DEFAULT 0, duration INTEGER, missing INTEGER DEFAULT 0, tag_scanned INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE storage_entries (id TEXT PRIMARY KEY, source_id TEXT, parent_id TEXT, path TEXT, kind TEXT, instance_id TEXT);
    CREATE TABLE storage_sources (id TEXT PRIMARY KEY, base_url TEXT, username TEXT, password TEXT, root_path TEXT, enabled INTEGER DEFAULT 1);
    CREATE TABLE annotations (user_id TEXT, item_type TEXT, item_id TEXT, starred INTEGER DEFAULT 0, starred_at INTEGER, rating INTEGER, play_count INTEGER DEFAULT 0, play_date INTEGER, PRIMARY KEY(user_id, item_type, item_id));
    CREATE TABLE users (username TEXT PRIMARY KEY, master_password TEXT, level INTEGER, enabled INTEGER DEFAULT 1, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE user_permissions (level INTEGER, permission TEXT, enabled INTEGER, max_rph INTEGER, PRIMARY KEY(level, permission));
    INSERT INTO users VALUES ('alice','x',2,1,0,0);
    INSERT INTO user_permissions VALUES (2,'edit_tags',1,0), (2,'manage_sources',1,0);
    INSERT INTO artists(id,name,sort_name) VALUES ('ar-track-a','Singer A','singer a'), ('ar-track-b','Singer B','singer b');
    INSERT INTO albums(id,name,sort_name) VALUES ('al-old','Old Album','old album');
    INSERT INTO song_masters(id,album_id,artist_id,title,sort_title,track,disc,duration,created_at,updated_at)
      VALUES ('sg-a','al-old','ar-track-a','Same Title','same title',1,1,10,1,1), ('sg-b','al-old','ar-track-b','Same Title','same title',2,1,10,2,2);
    INSERT INTO song_artists(song_id,artist_id,position) VALUES ('sg-a','ar-track-a',0), ('sg-a','ar-track-b',1), ('sg-b','ar-track-b',0);
    INSERT INTO song_instances(id,master_id,source_id,source_type,storage_uri,suffix,content_type,size,bit_rate,duration,created_at,updated_at)
      VALUES ('inst-a','sg-a','r2-local','original','r2://music/a.mp3','mp3','audio/mpeg',4,128,10,1,1), ('inst-b','sg-b','r2-local','original','r2://music/b.mp3','mp3','audio/mpeg',4,128,10,2,2);
  `);
  return db;
}

function appFor(sqlite: DatabaseSync) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "alice", level: 2, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/tag", tagEditRoutes);
  app.route("/tag", tagReadRoutes);
  app.route("/rest", subsonicRoutes);
  return (path: string, init?: RequestInit) => app.fetch(new Request(`http://test${path}`, init), {
    DB: d1(sqlite),
    MUSIC_BUCKET: {
      async get(key: string) {
        const bytes = key === "music/compilation-read.mp3" ? id3Compilation() : new Uint8Array([0x41, 0x55, 0x44, 0x49]);
        return { arrayBuffer: async () => bytes.buffer };
      },
      async put() {},
    },
    INSTANCE_ID: "test-instance",
  });
}

function id3Compilation(): Uint8Array {
  const encoder = new TextEncoder();
  const frame = (id: string, value: string) => {
    const body = Uint8Array.from([3, ...encoder.encode(value)]);
    const header = new Uint8Array(10);
    header.set(encoder.encode(id), 0);
    new DataView(header.buffer).setUint32(4, body.length);
    return Uint8Array.from([...header, ...body]);
  };
  const frames = [frame("TIT2", "Same Title"), frame("TPE1", "Guest Singer"), frame("TALB", "Old Album")];
  const size = frames.reduce((total, item) => total + item.length, 0);
  const header = Uint8Array.from([73, 68, 51, 3, 0, 0, (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127]);
  return Uint8Array.from([...header, ...frames.flatMap((item) => [...item])]);
}

async function main() {
  const sqlite = buildDb();
  const call = appFor(sqlite);
  const write = await call("/tag/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "sg-a", tags: { albumArtist: "Singer A, Singer B, Singer C" } }),
  });
  assert(write.status === 200, "album artist write route succeeds");
  const stored = sqlite.prepare("SELECT album_artist_id, artist_id FROM song_masters WHERE id = 'sg-a'").get() as { album_artist_id: string | null; artist_id: string };
  const other = sqlite.prepare("SELECT album_artist_id, artist_id FROM song_masters WHERE id = 'sg-b'").get() as { album_artist_id: string | null; artist_id: string };
  assert(stored.album_artist_id !== null, "album artist id is persisted");
  const storedArtist = sqlite.prepare("SELECT name FROM artists WHERE id = ?").get(stored.artist_id) as { name: string };
  assert(storedArtist.name === "Singer A", "track artist remains unchanged");
  const songArtists = sqlite.prepare("SELECT ar.name FROM song_artists sa JOIN artists ar ON ar.id = sa.artist_id WHERE sa.song_id = 'sg-a' ORDER BY sa.position").all() as Array<{ name: string }>;
  assert(songArtists.map((row) => row.name).join(", ") === "Singer A, Singer B", "multi-artist track credits remain complete");
  assert(other.album_artist_id === null && other.artist_id === "ar-track-b", "same-title song remains independent");

  const song = await call("/rest/getSong?id=sg-a");
  const songXml = await song.text();
  assert(song.status === 200 && /albumArtist="Singer A, Singer B, Singer C"/.test(songXml), "getSong returns persisted album artist");
  assert(/artist="Singer A, Singer B"/.test(songXml), "getSong keeps track artist");

  const search = await call("/rest/search3?query=Same%20Title&songCount=10&artistCount=0&albumCount=0");
  const searchXml = await search.text();
  assert(search.status === 200 && /albumArtist="Singer A, Singer B, Singer C"/.test(searchXml), "search3 returns album artist");
  assert((searchXml.match(/title="Same Title"/g) ?? []).length === 2, "search3 keeps both same-title songs");

  const q = createQueries(d1(sqlite));
  const top = await q.getTopSongsByArtist("Singer A", 10);
  assert(top.length === 1 && top[0].album_artist_name === "Singer A, Singer B, Singer C", "getTopSongsByArtist includes album artist join");

  const beforeTrackOnly = sqlite.prepare("SELECT album_id, album_artist_id FROM song_masters WHERE id = 'sg-a'").get() as { album_id: string; album_artist_id: string | null };
  await call("/tag/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "sg-a", tags: { title: "Renamed", track: 3 } }),
  });
  const afterTrackOnly = sqlite.prepare("SELECT album_id, album_artist_id, title FROM song_masters WHERE id = 'sg-a'").get() as { album_id: string; album_artist_id: string | null; title: string };
  assert(afterTrackOnly.title === "Renamed", "track-only edit is applied");
  assert(afterTrackOnly.album_id === beforeTrackOnly.album_id && afterTrackOnly.album_artist_id === beforeTrackOnly.album_artist_id, "track-only edit preserves album linkage");
  const preservedAlbumArtist = sqlite.prepare("SELECT name FROM artists WHERE id = ?").get(afterTrackOnly.album_artist_id) as { name: string };
  assert(preservedAlbumArtist.name === "Singer A, Singer B, Singer C", "track-only edit preserves complete album artist");
  const preservedCredits = sqlite.prepare("SELECT ar.name FROM song_artists sa JOIN artists ar ON ar.id = sa.artist_id WHERE sa.song_id = 'sg-a' ORDER BY sa.position").all() as Array<{ name: string }>;
  assert(preservedCredits.map((row) => row.name).join(", ") === "Singer A, Singer B", "track-only edit preserves multi-artist credits");

  await call("/tag/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "sg-a", tags: { albumArtist: "{null}" } }),
  });
  const cleared = await call("/rest/getSong?id=sg-a");
  const clearedXml = await cleared.text();
  assert(!/albumArtist=/.test(clearedXml), "cleared album artist is omitted from getSong");

  const artistOnly = await call("/tag/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "sg-a", tags: { artist: "New Singer" } }),
  });
  const artistOnlyRow = sqlite.prepare("SELECT album_id, album_artist_id FROM song_masters WHERE id = 'sg-a'").get() as { album_id: string; album_artist_id: string | null };
  assert(artistOnly.status === 200, "artist-only write route succeeds");
  assert(artistOnlyRow.album_id === `al-${md5("New Singer Old Album").substring(0, 10)}`, "artist-only edit anchors album to the new artist");
  assert(artistOnlyRow.album_artist_id === null, "artist-only edit leaves album artist empty");

  const scannedDb = buildDb();
  const scan = await applyMetadataResult(d1(scannedDb), "inst-a", {
    artist: "Singer A, Singer B", albumArtist: "Singer A, Singer B, Singer C", album: "Shared Album",
  }, {});
  const scanned = await createQueries(d1(scannedDb)).getSongMaster("sg-a");
  assert(scan.updated && scanned?.album_artist_name === "Singer A, Singer B, Singer C", "metadata ingestion preserves the complete album artist");
  assert(scanned?.artist_name === "Singer A, Singer B", "metadata ingestion preserves separate track credits");
  await applyMetadataResult(d1(scannedDb), "inst-a", { track: 7 }, {});
  const scanEdited = await createQueries(d1(scannedDb)).getSongMaster("sg-a");
  assert(scanEdited?.track === 7 && scanEdited.album_id === scanned?.album_id, "partial metadata update changes track without splitting the album");
  assert(scanEdited?.artist_name === scanned?.artist_name && scanEdited?.album_artist_name === scanned?.album_artist_name, "partial metadata update preserves both artist fields");
  await applyMetadataResult(d1(scannedDb), "inst-b", { artist: "New Singer" }, {});
  const newArtist = await createQueries(d1(scannedDb)).getSongMaster("sg-b");
  assert(newArtist?.album_id === `al-${md5("New Singer Old Album").substring(0, 10)}`, "metadata artist-only update uses the new artist for album identity");

  const compilationDb = buildDb();
  compilationDb.exec("UPDATE albums SET compilation = 1 WHERE id = 'al-old'");
  const compilationCall = appFor(compilationDb);
  const compilationWrite = await compilationCall("/tag/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "sg-b", tags: { artist: "Guest Singer" } }),
  });
  const compilationWritten = compilationDb.prepare("SELECT album_id, artist_id FROM song_masters WHERE id = 'sg-b'").get() as { album_id: string; artist_id: string };
  assert(compilationWrite.status === 200 && compilationWritten.album_id === "al-old", "tag write keeps artist edits inside a compilation");
  assert(compilationWritten.artist_id === `ar-${md5("Guest Singer").substring(0, 10)}`, "tag write still updates the track artist");
  await applyMetadataResult(d1(compilationDb), "inst-a", { artist: "Another Singer", album: "Old Album" }, {});
  const compilationScanned = compilationDb.prepare("SELECT album_id, artist_id FROM song_masters WHERE id = 'sg-a'").get() as { album_id: string; artist_id: string };
  assert(compilationScanned.album_id === "al-old", "metadata scan keeps the existing compilation album");
  assert(compilationScanned.artist_id === `ar-${md5("Another Singer").substring(0, 10)}`, "metadata scan still updates the track artist");
  await applyMetadataResult(d1(compilationDb), "inst-a", { album: "Renamed Album" }, {});
  const compilationRenamed = compilationDb.prepare("SELECT album_id FROM song_masters WHERE id = 'sg-a'").get() as { album_id: string };
  assert(compilationRenamed.album_id !== "al-old", "an explicit album rename moves the track out of the compilation");
  const compilationAlbumArtist = await compilationCall("/tag/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "sg-b", tags: { albumArtist: "Named Ensemble" } }),
  });
  const compilationRelinked = compilationDb.prepare("SELECT album_id FROM song_masters WHERE id = 'sg-b'").get() as { album_id: string };
  assert(compilationAlbumArtist.status === 200 && compilationRelinked.album_id !== "al-old", "an explicit album artist change moves the track out of the compilation");
  compilationDb.close();

  const readDb = buildDb();
  readDb.exec("UPDATE albums SET compilation = 1 WHERE id = 'al-old'; UPDATE song_instances SET tag_scanned = 1 WHERE id = 'inst-a'; UPDATE song_instances SET storage_uri = 'r2://music/compilation-read.mp3', tag_scanned = 0 WHERE id = 'inst-b'");
  const readResult = await appFor(readDb)("/tag/read?batch=1");
  const readRow = readDb.prepare("SELECT sm.album_id, ar.name AS artist_name, si.tag_scanned FROM song_masters sm JOIN artists ar ON ar.id = sm.artist_id JOIN song_instances si ON si.master_id = sm.id WHERE sm.id = 'sg-b'").get() as { album_id: string; artist_name: string; tag_scanned: number };
  assert(readResult.status === 200 && readRow.tag_scanned === 1, `Read Tags processes an imported compilation track (${readResult.status}, ${JSON.stringify(readRow)}, ${await readResult.text()})`);
  assert(readRow.album_id === "al-old" && readRow.artist_name === "Guest Singer", `Read Tags preserves compilation grouping while updating track artist (${JSON.stringify(readRow)})`);
  readDb.close();

  const importDb = buildDb();
  importDb.exec(`
    INSERT INTO albums(id,name,sort_name) VALUES ('pending-uploads','Pending Uploads','pending uploads');
    INSERT INTO song_masters(id,album_id,artist_id,title) VALUES
      ('import-a','pending-uploads','ar-track-a','First'),
      ('import-b','pending-uploads','ar-track-b','Second'),
      ('import-c','pending-uploads','ar-track-a','Other Folder'),
      ('import-d','pending-uploads','ar-track-a','Other Codec');
    INSERT INTO song_instances(id,master_id,source_id,storage_uri,suffix,size) VALUES
      ('import-inst-a','import-a','r2-local','r2://objects/a.flac','flac',100),
      ('import-inst-b','import-b','r2-local','r2://objects/b.flac','flac',100),
      ('import-inst-c','import-c','r2-local','r2://objects/c.flac','flac',100),
      ('import-inst-d','import-d','r2-local','r2://objects/d.wav','wav',100);
    INSERT INTO storage_entries(id,source_id,parent_id,path,kind,instance_id) VALUES
      ('entry-a','r2-local','release-folder','Compilation/01.flac','file','import-inst-a'),
      ('entry-b','r2-local','release-folder','Compilation/02.flac','file','import-inst-b'),
      ('entry-c','r2-local','other-folder','Other/01.flac','file','import-inst-c'),
      ('entry-d','r2-local','release-folder','Compilation/01.wav','file','import-inst-d');
  `);
  await applyMetadataResult(d1(importDb), "import-inst-a", { title: "First", artist: "Singer A", albumArtist: "Producer A", album: "Compilation", track: 1 }, {});
  await applyMetadataResult(d1(importDb), "import-inst-b", { title: "Second", artist: "Singer B", albumArtist: "Producer B", album: "Compilation", track: 2 }, {});
  const imported = importDb.prepare("SELECT id,album_id,artist_id,album_artist_id FROM song_masters WHERE id IN ('import-a','import-b') ORDER BY id").all() as Array<{ id: string; album_id: string; artist_id: string; album_artist_id: string }>;
  const importedAlbum = importDb.prepare("SELECT compilation,song_count FROM albums WHERE id = ?").get(imported[0].album_id) as { compilation: number; song_count: number };
  assert(imported[0].album_id === imported[1].album_id && importedAlbum.song_count === 2, "same-folder imports form one album despite per-track album artists");
  assert(importedAlbum.compilation === 1 && imported[0].album_artist_id !== imported[1].album_artist_id, "imported compilation retains the original track credits");
  await applyMetadataResult(d1(importDb), "import-inst-c", { title: "Other Folder", artist: "Singer A", album: "Compilation", track: 1 }, {});
  await applyMetadataResult(d1(importDb), "import-inst-d", { title: "Other Codec", artist: "Singer A", album: "Compilation", track: 1 }, {});
  const separate = importDb.prepare("SELECT id,album_id FROM song_masters WHERE id IN ('import-c','import-d') ORDER BY id").all() as Array<{ id: string; album_id: string }>;
  assert(separate.every((row) => row.album_id !== imported[0].album_id) && separate[0].album_id !== separate[1].album_id, "different folders and codecs retain separate album editions");
  importDb.close();
  scannedDb.close();
  sqlite.close();

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
