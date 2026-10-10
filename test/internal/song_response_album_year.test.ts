import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createQueries } from "../../worker/src/db/queries";
import { mapSong } from "../../worker/src/types/subsonic";

function d1(sqlite: DatabaseSync) {
  function prepare(sql: string) {
    const statement = sqlite.prepare(sql);
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) { args = values; return this; },
      async first<T>() { return (statement.get(...args) ?? null) as T | null; },
      async all<T>() { return { results: statement.all(...args) as T[] }; },
    };
  }
  return { prepare };
}

async function main() {
const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE artists(id TEXT PRIMARY KEY, name TEXT, sort_name TEXT);
  CREATE TABLE albums(id TEXT PRIMARY KEY, name TEXT, year INTEGER, cover_r2_key TEXT);
  CREATE TABLE song_masters(
    id TEXT PRIMARY KEY, album_id TEXT, artist_id TEXT, album_artist_id TEXT, title TEXT,
    sort_title TEXT, track INTEGER, disc INTEGER, duration INTEGER, genre TEXT,
    compilation INTEGER, participants TEXT, lyrics TEXT, lyrics_rich TEXT,
    created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE song_artists(song_id TEXT, artist_id TEXT, position INTEGER);
  CREATE TABLE song_instances(
    id TEXT PRIMARY KEY, master_id TEXT, missing INTEGER, storage_uri TEXT, suffix TEXT,
    content_type TEXT, bit_rate INTEGER, size INTEGER, duration INTEGER
  );
  INSERT INTO artists VALUES ('ar-a','RainCyclone','raincyclone');
  INSERT INTO albums VALUES ('al-a','The Example Album',2025,NULL), ('al-b','Undated Album',NULL,NULL);
  INSERT INTO song_masters VALUES
    ('sg-a','al-a','ar-a',NULL,'RainCyclone','raincyclone',1,NULL,240,NULL,0,NULL,NULL,NULL,1,1),
    ('sg-b','al-b','ar-a',NULL,'No Year','no year',2,NULL,180,NULL,0,NULL,NULL,NULL,2,2);
  INSERT INTO song_instances VALUES
    ('si-a','sg-a',0,'r2://objects/a.mp3','mp3','audio/mpeg',320,9000,240),
    ('si-b','sg-b',0,'r2://objects/b.mp3','mp3','audio/mpeg',320,8000,180);
`);

const queries = createQueries(d1(db) as never);
const withYear = await queries.getSongMaster("sg-a");
assert.equal(withYear?.album_year, 2025, "getSongMaster selects the joined album year");
assert.equal(mapSong(withYear!, withYear!.album_id).year, 2025, "mapSong exposes the album year in Child");

const search = await queries.search("", { artistCount: 0, albumCount: 0, songCount: 10 });
const searchedWithYear = search.songs.find((song) => song.id === "sg-a");
assert.equal(searchedWithYear?.album_year, 2025, "search projection includes the joined album year");
assert.equal(mapSong(searchedWithYear!, searchedWithYear!.album_id).year, 2025);

const withoutYear = await queries.getSongMaster("sg-b");
const childWithoutYear = mapSong(withoutYear!, withoutYear!.album_id);
assert.equal(withoutYear?.album_year, null, "an unset album year remains null in the query row");
assert.equal("year" in childWithoutYear, false, "an unset album year is omitted from the Subsonic child");

db.close();
console.log("✓ joined album year reaches song rows and is omitted when unset");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
