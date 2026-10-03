// SPDX-License-Identifier: AGPL-3.0-or-later
// Run: npx tsx test/subsonic/album_listening.test.ts

import { createQueries } from "../../worker/src/db/queries";
import { createDb, makeD1 } from "../helpers/albumListeningDb";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sqlite = createDb();
async function main() {
try {
  sqlite.exec(`
    INSERT INTO artists (id, name, sort_name) VALUES
      ('artist', 'Artist', 'artist');
    INSERT INTO albums (id, name, sort_name, created_at) VALUES
      ('album-a', 'Album A', 'album a', 100),
      ('album-b', 'Album B', 'album b', 200),
      ('album-c', 'Album C', 'album c', 300);
    INSERT INTO song_masters (id, album_id, artist_id, title, sort_title) VALUES
      ('song-a1', 'album-a', 'artist', 'A1', 'a1'),
      ('song-a2', 'album-a', 'artist', 'A2', 'a2'),
      ('song-b1', 'album-b', 'artist', 'B1', 'b1'),
      ('song-c1', 'album-c', 'artist', 'C1', 'c1');
    INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix) VALUES
      ('instance-a1', 'song-a1', 'source-a', 'r2://a1.flac', 'flac'),
      ('instance-a2', 'song-a2', 'source-b', 'r2://a2.flac', 'flac'),
      ('instance-b1', 'song-b1', 'source-b', 'r2://b1.flac', 'flac'),
      ('instance-c1', 'song-c1', 'source-a', 'r2://c1.flac', 'flac');
  `);

  const queries = createQueries(makeD1(sqlite));
  assert((await queries.listAlbums("frequent", 10, 0)).length === 0, "frequent is empty without song play records");
  assert((await queries.listAlbums("recent", 10, 0)).length === 0, "recent is empty without song play records");

  await queries.scrobbleSong("alice", "song-a1", 1000);
  await queries.scrobbleSong("alice", "song-a1", 2000);
  await queries.scrobbleSong("bob", "song-a2", 1500);
  await queries.scrobbleSong("alice", "song-b1", 3000);

  const frequent = await queries.listAlbums("frequent", 10, 0);
  assert(frequent.map((album) => album.id).join(",") === "album-a,album-b", "frequent aggregates across tracks and users and sorts by total plays");
  assert(frequent[0].play_count === 3, "same-album song plays are summed across users");
  assert(frequent[1].play_count === 1, "other album play count is independent");

  const recent = await queries.listAlbums("recent", 10, 0);
  assert(recent.map((album) => album.id).join(",") === "album-b,album-a", "recent sorts by latest song play date");
  assert(recent[0].play_date === 3000, "recent timestamp is sourced from song annotation");
  assert((await queries.listAlbums("recent", 1, 1)).map((album) => album.id).join(",") === "album-a", "recent pagination applies after aggregate ordering");

  const sourceA = await queries.listAlbums("frequent", 10, 0, { musicFolderId: "source-a" });
  assert(sourceA.map((album) => album.id).join(",") === "album-a", "folder filtering applies while listening totals remain album-wide");
  const sourceB = await queries.listAlbums("recent", 10, 0, { musicFolderId: "source-b" });
  assert(sourceB.map((album) => album.id).join(",") === "album-b,album-a", "folder filter includes albums with an instance in the selected source");
  assert((await queries.listAlbums("frequent", 10, 0, { musicFolderId: "default" })).length === 2, "aggregate folder keeps whole-library results");

  console.log("album listening integration: PASS");
} finally {
  sqlite.close();
}
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
