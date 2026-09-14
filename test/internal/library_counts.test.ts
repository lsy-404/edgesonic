import { DatabaseSync } from "node:sqlite";
import { createQueries } from "../../worker/src/db/queries";

declare global { type D1Database = unknown; }

function makeD1(sqlite: DatabaseSync): any {
  return {
    prepare(query: string) {
      const statement = sqlite.prepare(query);
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) { args = values; return this; },
        async first<T = unknown>() { return (statement.get(...args) ?? null) as T | null; },
      };
    },
  };
}

async function main() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE artists (id TEXT PRIMARY KEY);
    CREATE TABLE albums (id TEXT PRIMARY KEY);
    CREATE TABLE song_masters (id TEXT PRIMARY KEY, artist_id TEXT, album_artist_id TEXT, album_id TEXT);
    CREATE TABLE song_instances (id TEXT PRIMARY KEY, master_id TEXT, missing INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE song_artists (song_id TEXT, artist_id TEXT);
    INSERT INTO artists VALUES ('active-artist'), ('missing-artist');
    INSERT INTO albums VALUES ('active-album'), ('missing-album');
    INSERT INTO song_masters VALUES
      ('active-song', 'active-artist', NULL, 'active-album'),
      ('missing-song', 'missing-artist', NULL, 'missing-album');
    INSERT INTO song_instances VALUES ('active-instance', 'active-song', 0), ('missing-instance', 'missing-song', 1);
  `);

  const counts = await createQueries(makeD1(sqlite)).getLibraryCounts();
  if (counts.artists !== 1 || counts.albums !== 1 || counts.songs !== 1) {
    throw new Error(`expected active catalog counts, got ${JSON.stringify(counts)}`);
  }
  console.log("Library counts exclude missing-only catalog records.");
}

main().catch((error) => { console.error(error); process.exit(1); });
