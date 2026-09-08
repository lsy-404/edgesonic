// SPDX-License-Identifier: AGPL-3.0-or-later
// Real SQLite-backed tag write and Subsonic read round-trip.
// Run: npx tsx test/internal/album_artist_roundtrip.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { tagEditRoutes } from "../../worker/src/endpoints/tag/write";
import { subsonicRoutes } from "../../worker/src/endpoints/subsonic";
import { createQueries } from "../../worker/src/db/queries";

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
    CREATE TABLE storage_sources (id TEXT PRIMARY KEY, base_url TEXT, username TEXT, password TEXT, root_path TEXT, enabled INTEGER DEFAULT 1);
    CREATE TABLE annotations (user_id TEXT, item_type TEXT, item_id TEXT, starred INTEGER DEFAULT 0, starred_at INTEGER, rating INTEGER, play_count INTEGER DEFAULT 0, play_date INTEGER, PRIMARY KEY(user_id, item_type, item_id));
    CREATE TABLE users (username TEXT PRIMARY KEY, master_password TEXT, level INTEGER, enabled INTEGER DEFAULT 1, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE user_permissions (level INTEGER, permission TEXT, enabled INTEGER, max_rph INTEGER, PRIMARY KEY(level, permission));
    INSERT INTO users VALUES ('alice','x',2,1,0,0);
    INSERT INTO user_permissions VALUES (2,'edit_tags',1,0);
    INSERT INTO artists(id,name,sort_name) VALUES ('ar-track-a','Track A','track a'), ('ar-track-b','Track B','track b');
    INSERT INTO albums(id,name,sort_name) VALUES ('al-old','Old Album','old album');
    INSERT INTO song_masters(id,album_id,artist_id,title,sort_title,track,disc,duration,created_at,updated_at)
      VALUES ('sg-a','al-old','ar-track-a','Same Title','same title',1,1,10,1,1), ('sg-b','al-old','ar-track-b','Same Title','same title',2,1,10,2,2);
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
  app.route("/rest", subsonicRoutes);
  return (path: string, init?: RequestInit) => app.fetch(new Request(`http://test${path}`, init), {
    DB: d1(sqlite),
    MUSIC_BUCKET: {
      async get() { return { arrayBuffer: async () => new Uint8Array([0x41, 0x55, 0x44, 0x49]).buffer }; },
      async put() {},
    },
    INSTANCE_ID: "test-instance",
  });
}

async function main() {
  const sqlite = buildDb();
  const call = appFor(sqlite);
  const write = await call("/tag/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "sg-a", tags: { albumArtist: "Album Artist" } }),
  });
  assert(write.status === 200, "album artist write route succeeds");
  const stored = sqlite.prepare("SELECT album_artist_id, artist_id FROM song_masters WHERE id = 'sg-a'").get() as { album_artist_id: string | null; artist_id: string };
  const other = sqlite.prepare("SELECT album_artist_id, artist_id FROM song_masters WHERE id = 'sg-b'").get() as { album_artist_id: string | null; artist_id: string };
  assert(stored.album_artist_id !== null, "album artist id is persisted");
  const storedArtist = sqlite.prepare("SELECT name FROM artists WHERE id = ?").get(stored.artist_id) as { name: string };
  assert(storedArtist.name === "Track A", "track artist remains unchanged");
  assert(other.album_artist_id === null && other.artist_id === "ar-track-b", "same-title song remains independent");

  const song = await call("/rest/getSong?id=sg-a");
  const songXml = await song.text();
  assert(song.status === 200 && /albumArtist="Album Artist"/.test(songXml), "getSong returns persisted album artist");
  assert(/artist="Track A"/.test(songXml), "getSong keeps track artist");

  const search = await call("/rest/search3?query=Same%20Title&songCount=10&artistCount=0&albumCount=0");
  const searchXml = await search.text();
  assert(search.status === 200 && /albumArtist="Album Artist"/.test(searchXml), "search3 returns album artist");
  assert((searchXml.match(/title="Same Title"/g) ?? []).length === 2, "search3 keeps both same-title songs");

  const q = createQueries(d1(sqlite));
  const top = await q.getTopSongsByArtist("Track A", 10);
  assert(top.length === 1 && top[0].album_artist_name === "Album Artist", "getTopSongsByArtist includes album artist join");

  await call("/tag/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "sg-a", tags: { albumArtist: "{null}" } }),
  });
  const cleared = await call("/rest/getSong?id=sg-a");
  const clearedXml = await cleared.text();
  assert(!/albumArtist=/.test(clearedXml), "cleared album artist is omitted from getSong");

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
