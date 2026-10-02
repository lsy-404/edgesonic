import { LIBRARY_COUNTS_SQL } from "../db/queries";

export interface LibraryStatsRow {
  id: number;
  artists: number;
  albums: number;
  songs: number;
  updated_at: number | null;
  dirty: number;
}

const DIRTY_REFRESH_SQL = `
  UPDATE library_stats_cache
  SET (artists, albums, songs) = (${LIBRARY_COUNTS_SQL}),
      dirty = 0,
      updated_at = unixepoch()
  WHERE id = 1 AND (dirty = 1 OR updated_at IS NULL)
  RETURNING id, artists, albums, songs, updated_at, dirty
`;

export async function readLibraryStats(db: D1Database): Promise<LibraryStatsRow | null> {
  return db.prepare(
    "SELECT id, artists, albums, songs, updated_at, dirty FROM library_stats_cache WHERE id = 1",
  ).first<LibraryStatsRow>();
}

export async function refreshLibraryStats(db: D1Database, force = false): Promise<LibraryStatsRow | null> {
  if (force) {
    return db.prepare(`
      INSERT INTO library_stats_cache (id, artists, albums, songs, updated_at, dirty)
      SELECT 1, counts.artists, counts.albums, counts.songs, unixepoch(), 0
      FROM (${LIBRARY_COUNTS_SQL}) AS counts
      WHERE 1
      ON CONFLICT(id) DO UPDATE SET
        artists = excluded.artists,
        albums = excluded.albums,
        songs = excluded.songs,
        updated_at = unixepoch(),
        dirty = 0
      RETURNING id, artists, albums, songs, updated_at, dirty
    `).first<LibraryStatsRow>();
  }
  return db.prepare(DIRTY_REFRESH_SQL).first<LibraryStatsRow>();
}

export async function initializeAndRefreshLibraryStats(db: D1Database): Promise<LibraryStatsRow | null> {
  const results = await db.batch([
    db.prepare(`
      INSERT OR IGNORE INTO library_stats_cache (id, artists, albums, songs, updated_at, dirty)
      VALUES (1, 0, 0, 0, NULL, 1)
    `),
    db.prepare(DIRTY_REFRESH_SQL),
  ]);
  const rows = results[1]?.results as LibraryStatsRow[] | undefined;
  return rows?.[0] ?? null;
}
