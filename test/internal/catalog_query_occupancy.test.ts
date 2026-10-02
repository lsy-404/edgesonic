// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createQueries } from "../../worker/src/db/queries";

declare global { type D1Database = unknown; }

const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys=OFF");
sqlite.exec(readFileSync("worker/migrations/Schema.sql", "utf8"));
sqlite.exec(`
  INSERT INTO artists(id, name, sort_name) VALUES
    ('a1', 'Artist One', 'Artist One'), ('a2', 'Artist Two', 'Artist Two'),
    ('a3', 'Orphan', 'Orphan'), ('a4', 'Guest Artist', 'Guest Artist');
  INSERT INTO albums(id, name, sort_name) VALUES
    ('al1', 'Album One', 'Album One'), ('al2', 'Album Two', 'Album Two'), ('al3', 'Missing Album', 'Missing Album');
`);
const total = 1200;
const addSong = sqlite.prepare(`
  INSERT INTO song_masters(id, album_id, artist_id, album_artist_id, title, sort_title, lyrics, created_at)
  VALUES(?, ?, ?, ?, ?, ?, ?, ?)
`);
const addInstance = sqlite.prepare(`
  INSERT INTO song_instances(id, master_id, source_id, storage_uri, suffix, bit_rate, missing)
  VALUES(?, ?, 'r2-local', ?, 'mp3', ?, ?)
`);
for (let i = 0; i < total; i++) {
  const id = `s${String(i).padStart(4, "0")}`;
  const artist = i % 3 === 0 ? "a1" : "a2";
  const album = i % 2 === 0 ? "al1" : "al2";
  const title = `Shared ${String(i % 4).padStart(2, "0")}`;
  addSong.run(id, album, artist, i % 5 === 0 ? "a2" : null, title, title, "x".repeat(8000), 100 + (i % 7));
  addInstance.run(`i${i}`, id, `r2://objects/${id}.mp3`, 128 + (i % 3), i === 7 ? 1 : 0);
  if (i % 11 === 0) addInstance.run(`i${i}-copy`, id, `webdav://copy/${id}.mp3`, 320, 0);
}
sqlite.exec(`
  INSERT INTO song_artists(song_id, artist_id, position) VALUES ('s0000', 'a4', 0);
  INSERT INTO song_masters(id, album_id, artist_id, title, sort_title) VALUES ('missing-only', 'al3', 'a3', 'Missing only', 'Missing only');
  INSERT INTO song_instances(id, master_id, source_id, storage_uri, suffix, missing) VALUES ('missing-only-instance', 'missing-only', 'r2-local', 'r2://missing.mp3', 'mp3', 1);
  INSERT INTO song_instances(id, master_id, source_id, storage_uri, suffix, missing) VALUES ('orphan-instance', 'gone-song', 'r2-local', 'r2://orphan.mp3', 'mp3', 0);
`);

const calls: Array<{ sql: string; args: SQLInputValue[] }> = [];
const db = {
  prepare(sql: string) {
    const statement = sqlite.prepare(sql);
    let args: SQLInputValue[] = [];
    return {
      bind(...values: SQLInputValue[]) { args = values; return this; },
      async first<T>() { calls.push({ sql, args }); return (statement.get(...args) ?? null) as T | null; },
      async all<T>() { calls.push({ sql, args }); return { results: statement.all(...args) as T[], success: true }; },
    };
  },
} as unknown as D1Database;

async function main() {
  const queries = createQueries(db);
  for (const songSort of ["title", "titleDesc", "newest", "oldest"] as const) {
    const first = await queries.search("Shared", { artistCount: 0, albumCount: 0, songCount: 9, songSort });
    const second = await queries.search("Shared", { artistCount: 0, albumCount: 0, songCount: 9, songOffset: 9, songSort });
    const order = songSort === "newest" ? "sm.created_at DESC" : songSort === "oldest" ? "sm.created_at ASC" : songSort === "titleDesc" ? "sm.sort_title DESC" : "sm.sort_title ASC";
    const idOrder = songSort === "newest" || songSort === "titleDesc" ? "DESC" : "ASC";
    const expected = sqlite.prepare(`SELECT sm.id FROM song_masters sm WHERE sm.title LIKE ? ORDER BY ${order}, sm.id ${idOrder} LIMIT 18`).all("%Shared%") as Array<{ id: string }>;
    assert.deepEqual([...first.songs, ...second.songs].map((song) => song.id), expected.map((row) => row.id), `${songSort} pages are stable and match reference ordering`);
    assert.ok(first.songs.every((song) => !("lyrics" in song) && !("lyrics_rich" in song) && !("participants" in song)), "search projection excludes large lyrics and participant fields");
  }
  const pageCall = calls.findLast(({ sql }) => sql.includes("WITH page AS MATERIALIZED"))!;
  const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${pageCall.sql}`).all(...pageCall.args) as Array<{ detail: string }>;
  assert.ok(plan.some(({ detail }) => detail.includes("MATERIALIZE page")), "query plan materializes the bounded ID page");
  const pageScan = plan.findIndex(({ detail }) => detail === "SCAN page");
  const songLookup = plan.findIndex(({ detail }) => /SEARCH sm USING .*\(id=\?\)/u.test(detail));
  const artistLookup = plan.findIndex(({ detail }) => detail.startsWith("SEARCH ar "));
  assert.ok(pageScan >= 0 && pageScan < songLookup && songLookup < artistLookup, "page IDs drive song and artist detail lookups");
  assert.ok(pageCall.sql.indexOf("WITH page AS MATERIALIZED") < pageCall.sql.indexOf("LEFT JOIN artists ar"), "artist, album, and instance expansion follows the page CTE");
  for (const call of calls.filter(({ sql }) => sql.includes("WITH page AS MATERIALIZED"))) {
    const pagePlan = sqlite.prepare(`EXPLAIN QUERY PLAN ${call.sql}`).all(...call.args) as Array<{ detail: string }>;
    const pageRead = pagePlan.findIndex(({ detail }) => detail === "SCAN page");
    const orderIndex = call.sql.includes("ORDER BY sm.created_at") ? "idx_songmasters_created_id" : "idx_songmasters_sort_title_id";
    assert.ok(pagePlan.slice(0, pageRead).some(({ detail }) => detail.includes(orderIndex)), `${orderIndex} supplies page ordering`);
    assert.ok(!pagePlan.slice(0, pageRead).some(({ detail }) => detail.includes("TEMP B-TREE")), "page selection needs no temporary sort");
  }
  const baselineSql = `SELECT sm.id, ar.name, al.name, si.storage_uri
    FROM song_masters sm
    LEFT JOIN artists ar ON ar.id = sm.artist_id
    LEFT JOIN albums al ON al.id = sm.album_id
    LEFT JOIN song_instances si ON si.id = (
      SELECT id FROM song_instances WHERE master_id = sm.id AND missing = 0
      ORDER BY CASE WHEN storage_uri LIKE 'r2://%' THEN 0 ELSE 1 END, bit_rate DESC LIMIT 1
    )
    WHERE sm.title LIKE ? ORDER BY sm.created_at ASC, sm.id ASC LIMIT ? OFFSET ?`;
  const baselinePlan = sqlite.prepare(`EXPLAIN QUERY PLAN ${baselineSql}`).all("%Shared%", 9, 0) as Array<{ detail: string }>;
  assert.ok(baselinePlan.some(({ detail }) => detail.startsWith("SCAN sm USING INDEX idx_songmasters_created_id")), "pre-change plan scans the full ordered song index before LIMIT");
  console.log(`SQLite plan, before: ${baselinePlan.map(({ detail }) => detail).join("; ")}`);
  console.log(`SQLite plan, after: ${plan.map(({ detail }) => detail).join("; ")}`);

  const noRowsCalls = calls.length;
  const empty = await queries.search("", { artistCount: 0, albumCount: 0, songCount: 0 });
  assert.deepEqual(empty, { artists: [], albums: [], songs: [] });
  assert.equal(calls.length, noRowsCalls, "zero counts issue no catalog queries");
  const emptyLyrics = await queries.search("title", { lyricsQuery: "needle", songCount: 0 });
  assert.deepEqual(emptyLyrics, { artists: [], albums: [], songs: [] });
  assert.equal(calls.length, noRowsCalls, "zero song count bypasses lyrics index initialization and search");
  await assert.rejects(queries.search("", { lyricsQuery: "a".repeat(513), songCount: 0 }), /too-long/u);
  assert.equal(calls.length, noRowsCalls, "lyrics validation still runs before the zero-count short circuit");

  const baselineCounts = {
    artists: Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM artists ar
      WHERE EXISTS (SELECT 1 FROM song_masters sm JOIN song_instances si ON si.master_id = sm.id AND si.missing = 0
        WHERE sm.artist_id = ar.id OR sm.album_artist_id = ar.id
          OR EXISTS (SELECT 1 FROM song_artists sa WHERE sa.song_id = sm.id AND sa.artist_id = ar.id))`).get()!.n),
    albums: Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM albums al
      WHERE EXISTS (SELECT 1 FROM song_masters sm JOIN song_instances si ON si.master_id = sm.id AND si.missing = 0
        WHERE sm.album_id = al.id)`).get()!.n),
    songs: Number(sqlite.prepare(`SELECT COUNT(DISTINCT sm.id) AS n FROM song_masters sm
      JOIN song_instances si ON si.master_id = sm.id WHERE si.missing = 0`).get()!.n),
  };
  const counts = await queries.getLibraryCounts();
  assert.deepEqual(counts, baselineCounts, "set-based counts match previous playable artist, album, and song semantics");
  assert.deepEqual(counts, { artists: 3, albums: 2, songs: total - 1 }, "counts include coartists and album artists once, excluding missing-only and orphan records");
  const countCall = calls.findLast(({ sql }) => sql.includes("WITH playable AS MATERIALIZED"))!;
  const countPlan = sqlite.prepare(`EXPLAIN QUERY PLAN ${countCall.sql}`).all(...countCall.args) as Array<{ detail: string }>;
  assert.ok(countPlan.some(({ detail }) => detail.includes("idx_instances_playable_master")), "set-based counts scan the partial playable-instance index");
  const oldArtistSql = `SELECT COUNT(*) FROM artists ar
    WHERE EXISTS (SELECT 1 FROM song_masters sm JOIN song_instances si ON si.master_id = sm.id AND si.missing = 0
      WHERE sm.artist_id = ar.id OR sm.album_artist_id = ar.id
        OR EXISTS (SELECT 1 FROM song_artists sa WHERE sa.song_id = sm.id AND sa.artist_id = ar.id))`;
  const oldArtistPlan = sqlite.prepare(`EXPLAIN QUERY PLAN ${oldArtistSql}`).all() as Array<{ detail: string }>;
  console.log(`SQLite plan, counts before: ${oldArtistPlan.map(({ detail }) => detail).join("; ")}`);
  console.log(`SQLite plan, counts after: ${countPlan.map(({ detail }) => detail).join("; ")}`);
  sqlite.close();
  console.log("PASS: 1,200-song pagination, tie-breaks, bounded detail joins, zero-count short circuits, and playable catalog counts.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
