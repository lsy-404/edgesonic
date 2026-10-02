import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Hono } from "hono";
import { statsRoutes } from "../../worker/src/endpoints/edgesonic/stats";
import { readLibraryStats, refreshLibraryStats } from "../../worker/src/utils/libraryStats";

declare global { type D1Database = unknown; type Env = unknown; }

type D1Call = { sql: string; args: SQLInputValue[] };

function makeD1(sqlite: DatabaseSync, calls: D1Call[], deferRefresh = false) {
  return {
    prepare(sql: string) {
      let args: SQLInputValue[] = [];
      const statement = sqlite.prepare(sql);
      const prepared = {
        sql,
        values: () => args,
        bind(...values: SQLInputValue[]) { args = values; return this; },
        async first<T>() {
          if (deferRefresh && /^\s*UPDATE\s+library_stats_cache\b/i.test(sql)) {
            return new Promise<T | null>((resolve, reject) => setTimeout(() => {
              try {
                calls.push({ sql, args });
                resolve((statement.get(...args) ?? null) as T | null);
              } catch (error) { reject(error); }
            }, 0));
          }
          calls.push({ sql, args });
          return (statement.get(...args) ?? null) as T | null;
        },
        async all<T>() {
          calls.push({ sql, args });
          return { results: statement.all(...args) as T[], success: true };
        },
        async run() {
          calls.push({ sql, args });
          return { success: true, meta: statement.run(...args) };
        },
      };
      return prepared;
    },
    async batch(statements: Array<{ sql: string; values(): SQLInputValue[] }>) {
      const execute = () => {
        sqlite.exec("BEGIN");
        try {
          const results = statements.map(({ sql, values }) => {
            const args = values();
            calls.push({ sql, args });
            const statement = sqlite.prepare(sql);
            if (/\bRETURNING\b/i.test(sql)) {
              return { success: true, results: statement.all(...args) };
            }
            return { success: true, meta: statement.run(...args) };
          });
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      };
      if (deferRefresh && statements.some(({ sql }) => /^\s*UPDATE\s+library_stats_cache\b/i.test(sql))) {
        return new Promise((resolve, reject) => setTimeout(() => {
          try { resolve(execute()); } catch (error) { reject(error); }
        }, 0));
      }
      return execute();
    },
  };
}

function buildDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("worker/migrations/Schema.sql", "utf8"));
  sqlite.exec(`
    INSERT INTO artists(id, name) VALUES
      ('artist-a', 'Artist A'), ('artist-b', 'Artist B'), ('artist-credit', 'Artist Credit'), ('unused-artist', 'Unused');
    INSERT INTO albums(id, name) VALUES
      ('album-a', 'Album A'), ('album-missing', 'Missing Album'), ('unused-album', 'Unused');
    INSERT INTO song_masters(id, album_id, artist_id, album_artist_id, title) VALUES
      ('song-a', 'album-a', 'artist-a', 'artist-b', 'Song A'),
      ('song-b', 'album-a', 'artist-a', NULL, 'Song B'),
      ('song-missing', 'album-missing', 'artist-b', NULL, 'Missing'),
      ('song-no-instance', 'unused-album', 'unused-artist', NULL, 'No instance');
    INSERT INTO song_instances(id, master_id, source_id, storage_uri, suffix, missing) VALUES
      ('instance-a1', 'song-a', 'r2-local', 'r2://a.mp3', 'mp3', 0),
      ('instance-a2', 'song-a', 'r2-local', 'r2://a-copy.mp3', 'mp3', 0),
      ('instance-b', 'song-b', 'r2-local', 'r2://b.mp3', 'mp3', 0),
      ('instance-missing', 'song-missing', 'r2-local', 'r2://missing.mp3', 'mp3', 1);
    INSERT INTO song_artists(song_id, artist_id, position) VALUES ('song-b', 'artist-credit', 0);
  `);
  return sqlite;
}

function makeApp(sqlite: DatabaseSync, user: { username: string; level: number }, calls: D1Call[], deferRefresh = false) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    c.set("authMethod", "session");
    await next();
  });
  app.route("/edgesonic", statsRoutes);
  const env = { DB: makeD1(sqlite, calls, deferRefresh) };
  return {
    request(path: string, method = "GET", ctx: { waitUntil(promise: Promise<unknown>): void } = { waitUntil() {} }) {
      return app.fetch(new Request(`http://test${path}`, { method }), env as any, ctx as any);
    },
  };
}

async function main() {
  const sqlite = buildDb();
  const initial = await readLibraryStats(makeD1(sqlite, []));
  assert.ok(initial);
  assert.equal(initial.updated_at, null);
  assert.equal(initial.dirty, 1);

  const initialCalls: D1Call[] = [];
  const initialApp = makeApp(sqlite, { username: "admin", level: 3 }, initialCalls, true);
  const initialRefresh: Promise<unknown>[] = [];
  const initialResponse = await initialApp.request("/edgesonic/stats/library", "GET", { waitUntil: (p) => initialRefresh.push(p) });
  const initialBody = await initialResponse.json() as Record<string, unknown>;
  assert.deepEqual(initialBody, { ok: true, artists: 0, albums: 0, songs: 0, updatedAt: null, stale: true, ready: false });
  assert.equal(initialCalls.length, 1, "uninitialized GET performs only the cache SELECT before returning");
  assert.equal(initialRefresh.length, 1);
  assert.equal(sqlite.prepare("SELECT dirty FROM library_stats_cache WHERE id = 1").get()?.dirty, 1);
  await Promise.all(initialRefresh);
  assert.equal(initialCalls.length, 2);
  assert.match(initialCalls[1].sql, /UPDATE\s+library_stats_cache[\s\S]*WITH\s+playable[\s\S]*RETURNING/i, "one atomic UPDATE performs the rebuild");

  const first = await readLibraryStats(makeD1(sqlite, []));
  assert.deepEqual(
    { artists: first?.artists, albums: first?.albums, songs: first?.songs, dirty: first?.dirty },
    { artists: 3, albums: 1, songs: 2, dirty: 0 },
    "playable distinct songs include all credited artists and exclude missing-only and unreferenced rows",
  );

  const cleanRefreshCalls: D1Call[] = [];
  const untouched = await refreshLibraryStats(makeD1(sqlite, cleanRefreshCalls));
  assert.equal(untouched, null, "a clean cache skips the aggregate update");
  assert.match(cleanRefreshCalls[0].sql, /WHERE\s+id\s*=\s*1\s+AND\s+\(dirty\s*=\s*1\s+OR\s+updated_at\s+IS\s+NULL\)/i);

  sqlite.prepare("UPDATE library_stats_cache SET artists = 80, albums = 70, songs = 60 WHERE id = 1").run();
  const repaired = await refreshLibraryStats(makeD1(sqlite, []), true);
  assert.deepEqual(
    { artists: repaired?.artists, albums: repaired?.albums, songs: repaired?.songs, dirty: repaired?.dirty },
    { artists: 3, albums: 1, songs: 2, dirty: 0 },
    "forced rebuild repairs incorrect clean cache data",
  );

  const calls: D1Call[] = [];
  const app = makeApp(sqlite, { username: "admin", level: 3 }, calls, true);
  const background: Promise<unknown>[] = [];
  const response = await app.request("/edgesonic/stats/library", "GET", { waitUntil: (p) => background.push(p) });
  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual(body, {
    ok: true, artists: 3, albums: 1, songs: 2,
    updatedAt: repaired?.updated_at, stale: false, ready: true,
  });
  assert.equal(calls.length, 1, "GET performs only the cache row SELECT");
  assert.match(calls[0].sql, /FROM\s+library_stats_cache/i);
  assert.equal(sqlite.prepare("SELECT dirty FROM library_stats_cache WHERE id = 1").get()?.dirty, 0, "GET does not synchronously refresh the cache");
  assert.equal(background.length, 0, "a clean cache schedules no background work");

  sqlite.prepare("UPDATE library_stats_cache SET dirty = 1 WHERE id = 1").run();
  const dirtyCalls: D1Call[] = [];
  const dirtyApp = makeApp(sqlite, { username: "admin", level: 3 }, dirtyCalls, true);
  const scheduled: Promise<unknown>[] = [];
  const dirtyResponse = await dirtyApp.request("/edgesonic/stats/library", "GET", { waitUntil: (p) => scheduled.push(p) });
  const staleBody = await dirtyResponse.json() as Record<string, unknown>;
  assert.equal(staleBody.stale, true);
  assert.equal(staleBody.ready, true);
  assert.equal(scheduled.length, 1, "dirty cache schedules one refresh");
  assert.equal(dirtyCalls.length, 1, "GET has not executed the background update before returning");
  assert.match(dirtyCalls[0].sql, /FROM\s+library_stats_cache/i);
  const secondDirtyResponse = await dirtyApp.request("/edgesonic/stats/library", "GET", { waitUntil: (p) => scheduled.push(p) });
  assert.equal((await secondDirtyResponse.json() as Record<string, unknown>).stale, true);
  assert.equal(scheduled.length, 2, "concurrent dirty reads each schedule background work without a process lock");
  const refreshResults = await Promise.all(scheduled);
  assert.equal(refreshResults.filter(Boolean).length, 1, "dirty guard allows only one concurrent refresh to update the cache");
  assert.equal(sqlite.prepare("SELECT dirty FROM library_stats_cache WHERE id = 1").get()?.dirty, 0);
  assert.equal(dirtyCalls.length, 4);

  sqlite.prepare("DELETE FROM library_stats_cache WHERE id = 1").run();
  const missingCalls: D1Call[] = [];
  const missingApp = makeApp(sqlite, { username: "admin", level: 3 }, missingCalls, true);
  const missingRefresh: Promise<unknown>[] = [];
  const missingResponse = await missingApp.request("/edgesonic/stats/library", "GET", { waitUntil: (p) => missingRefresh.push(p) });
  const missingBody = await missingResponse.json() as Record<string, unknown>;
  assert.deepEqual(missingBody, { ok: true, artists: 0, albums: 0, songs: 0, updatedAt: null, stale: true, ready: false });
  assert.equal(missingCalls.length, 1, "missing-row GET only reads synchronously");
  const missingResponse2 = await missingApp.request("/edgesonic/stats/library", "GET", { waitUntil: (p) => missingRefresh.push(p) });
  assert.equal((await missingResponse2.json() as Record<string, unknown>).ready, false);
  assert.equal(missingRefresh.length, 2);
  const missingResults = await Promise.all(missingRefresh);
  assert.equal(missingResults.filter(Boolean).length, 1, "atomic seed-and-refresh repairs a missing row once");
  const recoveredRow = await readLibraryStats(makeD1(sqlite, []));
  assert.equal(recoveredRow?.dirty, 0);
  assert.equal(recoveredRow?.updated_at !== null, true);
  assert.deepEqual([recoveredRow?.artists, recoveredRow?.albums, recoveredRow?.songs], [3, 1, 2]);

  const triggerCache = (dirty: number) => sqlite.prepare("UPDATE library_stats_cache SET dirty = ? WHERE id = 1").run(dirty);
  triggerCache(0);
  sqlite.prepare("UPDATE song_masters SET title = 'renamed', lyrics = 'text' WHERE id = 'song-a'").run();
  sqlite.prepare("UPDATE song_artists SET position = 5 WHERE song_id = 'song-b'").run();
  assert.equal(sqlite.prepare("SELECT dirty FROM library_stats_cache WHERE id = 1").get()?.dirty, 0, "title, lyrics, and relation position edits do not invalidate counts");

  sqlite.prepare("UPDATE song_masters SET album_artist_id = 'artist-credit' WHERE id = 'song-a'").run();
  assert.equal(sqlite.prepare("SELECT dirty FROM library_stats_cache WHERE id = 1").get()?.dirty, 1, "master relationship changes invalidate counts");
  triggerCache(0);
  sqlite.prepare("UPDATE song_masters SET id = 'song-no-instance-renamed' WHERE id = 'song-no-instance'").run();
  assert.equal(sqlite.prepare("SELECT dirty FROM library_stats_cache WHERE id = 1").get()?.dirty, 1, "master id changes invalidate counts");
  triggerCache(0);
  sqlite.prepare("INSERT INTO song_masters(id, album_id, artist_id, title) VALUES ('temporary-song', 'album-a', 'artist-a', 'Temporary')").run();
  assert.equal(sqlite.prepare("SELECT dirty FROM library_stats_cache WHERE id = 1").get()?.dirty, 1, "master insertion invalidates counts");
  triggerCache(0);
  sqlite.prepare("DELETE FROM song_masters WHERE id = 'temporary-song'").run();
  assert.equal(sqlite.prepare("SELECT dirty FROM library_stats_cache WHERE id = 1").get()?.dirty, 1, "master deletion invalidates counts");
  triggerCache(0);
  sqlite.prepare("UPDATE song_instances SET missing = 1 WHERE id = 'instance-b'").run();
  assert.equal(sqlite.prepare("SELECT dirty FROM library_stats_cache WHERE id = 1").get()?.dirty, 1, "playable instance changes invalidate counts");
  triggerCache(0);
  sqlite.prepare("UPDATE song_instances SET master_id = 'song-b' WHERE id = 'instance-a2'").run();
  assert.equal(sqlite.prepare("SELECT dirty FROM library_stats_cache WHERE id = 1").get()?.dirty, 1, "playable instance master changes invalidate counts");
  triggerCache(0);
  sqlite.prepare("INSERT INTO song_instances(id, master_id, source_id, storage_uri, suffix, missing) VALUES ('temporary-instance', 'song-a', 'r2-local', 'r2://tmp.mp3', 'mp3', 0)").run();
  assert.equal(sqlite.prepare("SELECT dirty FROM library_stats_cache WHERE id = 1").get()?.dirty, 1, "playable instance insertion invalidates counts");
  triggerCache(0);
  sqlite.prepare("DELETE FROM song_instances WHERE id = 'temporary-instance'").run();
  assert.equal(sqlite.prepare("SELECT dirty FROM library_stats_cache WHERE id = 1").get()?.dirty, 1, "playable instance deletion invalidates counts");
  triggerCache(0);
  sqlite.prepare("INSERT INTO song_artists(song_id, artist_id, position) VALUES ('song-a', 'artist-a', 1)").run();
  assert.equal(sqlite.prepare("SELECT dirty FROM library_stats_cache WHERE id = 1").get()?.dirty, 1, "artist relation insertion invalidates counts");
  triggerCache(0);
  sqlite.prepare("DELETE FROM song_artists WHERE song_id = 'song-a' AND artist_id = 'artist-a'").run();
  assert.equal(sqlite.prepare("SELECT dirty FROM library_stats_cache WHERE id = 1").get()?.dirty, 1, "artist relation deletion invalidates counts");
  triggerCache(0);
  sqlite.prepare("UPDATE song_artists SET artist_id = 'artist-a' WHERE song_id = 'song-b'").run();
  assert.equal(sqlite.prepare("SELECT dirty FROM library_stats_cache WHERE id = 1").get()?.dirty, 1, "artist relation changes invalidate counts");
  triggerCache(0);
  sqlite.prepare("INSERT INTO artists(id, name) VALUES ('new-artist', 'New Artist')").run();
  assert.equal(sqlite.prepare("SELECT dirty FROM library_stats_cache WHERE id = 1").get()?.dirty, 1, "artist insertion invalidates counts");
  triggerCache(0);
  sqlite.prepare("INSERT INTO albums(id, name) VALUES ('new-album', 'New Album')").run();
  assert.equal(sqlite.prepare("SELECT dirty FROM library_stats_cache WHERE id = 1").get()?.dirty, 1, "album insertion invalidates counts");
  triggerCache(0);
  sqlite.prepare("UPDATE albums SET id = 'new-album-renamed' WHERE id = 'new-album'").run();
  assert.equal(sqlite.prepare("SELECT dirty FROM library_stats_cache WHERE id = 1").get()?.dirty, 1, "album id changes invalidate counts");
  triggerCache(0);
  sqlite.prepare("DELETE FROM albums WHERE id = 'new-album-renamed'").run();
  assert.equal(sqlite.prepare("SELECT dirty FROM library_stats_cache WHERE id = 1").get()?.dirty, 1, "album deletion invalidates counts");
  triggerCache(0);
  sqlite.prepare("UPDATE artists SET id = 'new-artist-renamed' WHERE id = 'new-artist'").run();
  assert.equal(sqlite.prepare("SELECT dirty FROM library_stats_cache WHERE id = 1").get()?.dirty, 1, "artist id changes invalidate counts");
  triggerCache(0);
  sqlite.prepare("DELETE FROM artists WHERE id = 'new-artist-renamed'").run();
  assert.equal(sqlite.prepare("SELECT dirty FROM library_stats_cache WHERE id = 1").get()?.dirty, 1, "artist deletion invalidates counts");

  const beforeRefresh = await refreshLibraryStats(makeD1(sqlite, []), true);
  assert.equal(beforeRefresh?.dirty, 0);
  sqlite.prepare("UPDATE song_instances SET missing = 1 WHERE id = 'instance-a2'").run();
  const afterConcurrentWrite = await readLibraryStats(makeD1(sqlite, []));
  assert.equal(afterConcurrentWrite?.dirty, 1, "a catalog change after refresh leaves the cache dirty for the next pass");

  const unauthorized = makeApp(sqlite, { username: "user", level: 1 }, []);
  const denied = await unauthorized.request("/edgesonic/stats/library/rebuild", "POST");
  assert.equal(denied.status, 403, "level 1 cannot rebuild counts");
  sqlite.prepare("UPDATE user_permissions SET enabled = 0 WHERE level = 1 AND permission = 'browse'").run();
  const noBrowse = await unauthorized.request("/edgesonic/stats/library");
  assert.equal(noBrowse.status, 403, "library cache reads require browse permission");
  sqlite.prepare("UPDATE user_permissions SET enabled = 1 WHERE level = 1 AND permission = 'browse'").run();

  const operator = makeApp(sqlite, { username: "operator", level: 2 }, []);
  const permissionDenied = await operator.request("/edgesonic/stats/library/rebuild", "POST");
  assert.equal(permissionDenied.status, 403, "level 2 requires maintenance_reclaim permission");
  sqlite.prepare("UPDATE library_stats_cache SET artists = 80, albums = 70, songs = 60, dirty = 0 WHERE id = 1").run();
  sqlite.prepare("UPDATE user_permissions SET enabled = 1 WHERE level = 2 AND permission = 'maintenance_reclaim'").run();
  const manual = await operator.request("/edgesonic/stats/library/rebuild", "POST");
  assert.equal(manual.status, 200);
  const manualBody = await manual.json() as Record<string, unknown>;
  assert.equal(manualBody.ready, true);
  assert.equal(manualBody.stale, false);
  assert.deepEqual([manualBody.artists, manualBody.albums, manualBody.songs], [2, 1, 1]);
  sqlite.prepare("DELETE FROM library_stats_cache WHERE id = 1").run();
  const missingManual = await operator.request("/edgesonic/stats/library/rebuild", "POST");
  assert.equal(missingManual.status, 200);
  const missingManualBody = await missingManual.json() as Record<string, unknown>;
  assert.equal(missingManualBody.ready, true);
  assert.deepEqual([missingManualBody.artists, missingManualBody.albums, missingManualBody.songs], [2, 1, 1]);

  console.log("Library statistics cache tests passed.");
}

main().catch((error) => { console.error(error); process.exit(1); });
