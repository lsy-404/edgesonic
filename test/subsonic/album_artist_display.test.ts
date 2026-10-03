import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createQueries } from "../../worker/src/db/queries";

function createDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../../worker/migrations/Schema.sql", import.meta.url), "utf8"));
  return sqlite;
}

function makeD1(sqlite: DatabaseSync): D1Database {
  return {
    prepare(query: string) {
      const statement = sqlite.prepare(query);
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) { args = values; return this; },
        async first<T = unknown>() { return (statement.get(...args) as T | undefined) ?? null; },
        async all<T = unknown>() { return { results: statement.all(...args) as T[], success: true, meta: {} }; },
        async run() { const result = statement.run(...args); return { success: true, meta: { changes: Number(result.changes ?? 0) } }; },
      };
    },
  } as unknown as D1Database;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sqlite = createDb();

async function main() {
  try {
    sqlite.exec(`
      INSERT INTO artists (id, name, sort_name) VALUES
        ('album-credit', 'Various Artists', 'various artists'),
        ('performer-a', 'Performer A', 'performer a'),
        ('performer-b', 'Performer B', 'performer b'),
        ('fallback-performer', 'Fallback Performer', 'fallback performer');
      INSERT INTO albums (id, name, sort_name, created_at) VALUES
        ('compiled-album', 'Compiled Album', 'compiled album', 1),
        ('solo-album', 'Solo Album', 'solo album', 2);
      INSERT INTO song_masters (id, album_id, artist_id, album_artist_id, title, track, disc) VALUES
        ('compiled-1', 'compiled-album', 'performer-a', 'album-credit', 'First', 1, 1),
        ('compiled-2', 'compiled-album', 'performer-b', 'album-credit', 'Second', 2, 1),
        ('solo-1', 'solo-album', 'fallback-performer', NULL, 'Solo', 1, 1);
      INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix) VALUES
        ('instance-1', 'compiled-1', 'source', 'r2://first.flac', 'flac'),
        ('instance-2', 'compiled-2', 'source', 'r2://second.flac', 'flac'),
        ('instance-3', 'solo-1', 'source', 'r2://solo.flac', 'flac');
      INSERT INTO album_display_groups (id, display_name, sort_name, created_at, updated_at)
        VALUES ('release-group', 'Compiled Editions', 'compiled editions', 1, 1);
      INSERT INTO album_display_group_members (group_id, album_id, sort_order) VALUES
        ('release-group', 'compiled-album', 0),
        ('release-group', 'solo-album', 1);
      INSERT INTO annotations (user_id, item_id, item_type, starred, starred_at)
        VALUES ('user', 'compiled-album', 'album', 1, 1);
    `);

    const queries = createQueries(makeD1(sqlite));
    const [group, albums, search, starred, songs, artistAlbums] = await Promise.all([
      queries.getAlbumDisplayGroup('release-group'),
      queries.listAlbums('newest', 10, 0),
      queries.search('Album', { artistCount: 0, albumCount: 10, songCount: 0 }),
      queries.getStarredAlbums('user'),
      queries.getSongMastersByAlbum('compiled-album'),
      queries.getAlbumsByArtist('performer-a'),
    ]);

    assert(group?.members[0]?.artist_name === 'Various Artists', 'display group uses album artist instead of the first performer');
    const compiled = albums.find((album) => album.id === 'compiled-album');
    const solo = albums.find((album) => album.id === 'solo-album');
    assert(compiled?.artist_name === 'Various Artists' && compiled.artist_id === 'album-credit', 'album listing uses album artist');
    assert(solo?.artist_name === 'Fallback Performer' && solo.artist_id === 'fallback-performer', 'album listing falls back to performer when album artist is null');
    const searched = search.albums.find((album) => album.id === 'compiled-album');
    assert(searched?.artist_name === 'Various Artists' && searched.artist_id === 'album-credit', 'album search uses album artist');
    assert(starred[0]?.artist_name === 'Various Artists' && starred[0]?.artist_id === 'album-credit', 'starred album listing uses album artist');
    assert(artistAlbums[0]?.artist_name === 'Various Artists' && artistAlbums[0]?.artist_id === 'album-credit', 'artist album listing uses album artist');
    assert(songs[0]?.artist_name === 'Performer A' && songs[0]?.album_artist_name === 'Various Artists', 'track performer and album artist remain separate');

    console.log('album artist display projections: PASS');
  } finally {
    sqlite.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
