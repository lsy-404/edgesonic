import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createQueries } from "../../worker/src/db/queries";
import { advanceLyricsSearchIndex, lyricsSearchGrams, normalizeLyricsSearchQuery, normalizeLyricsSearchText } from "../../worker/src/utils/lyricsSearch";

function fixture(existing = false) {
  const sqlite = new DatabaseSync(":memory:");
  let schema = readFileSync("worker/migrations/Schema.sql", "utf8");
  if (existing) schema = schema.replace(/CREATE TABLE IF NOT EXISTS lyrics_search_documents[\s\S]*?(?=CREATE TABLE IF NOT EXISTS song_artists)/u, "");
  sqlite.exec(schema);
  sqlite.exec("INSERT INTO artists(id,name) VALUES('artist','Artist'); INSERT INTO albums(id,name) VALUES('album','Album');");
  const calls: Array<{ sql: string; args: SQLInputValue[] }> = [];
  let beforeIndexBatch: (() => Promise<void>) | undefined;
  let failIndexBatch = false;
  function prepare(sql: string) {
    let args: SQLInputValue[] = [];
    return {
      sql,
      bind(...values: SQLInputValue[]) { args = values; return this; },
      async first<T>() { calls.push({ sql, args }); return (sqlite.prepare(sql).get(...args) ?? null) as T | null; },
      async all<T>() { calls.push({ sql, args }); return { results: sqlite.prepare(sql).all(...args) as T[], success: true }; },
      async run() { calls.push({ sql, args }); return { success: true, meta: sqlite.prepare(sql).run(...args) }; },
    };
  }
  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      const indexBatch = statements[0]?.sql.startsWith("WITH eligible");
      if (indexBatch && beforeIndexBatch) {
        const hook = beforeIndexBatch;
        beforeIndexBatch = undefined;
        await hook();
      }
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const [index, statement] of statements.entries()) {
          if (indexBatch && failIndexBatch && index === 2) {
            failIndexBatch = false;
            throw new Error("simulated D1 write failure");
          }
          results.push(await statement.run());
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  function insert(id: string, title: string, lyrics: string | null, rich: string | null = null, created = 100) {
    sqlite.prepare(`INSERT OR REPLACE INTO song_masters(id,title,sort_title,lyrics,lyrics_rich,album_id,artist_id,created_at)
      VALUES(?,?,?,?,?,'album','artist',?)`).run(id, title, title, lyrics, rich, created);
  }
  function count(table: string) {
    return Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
  }
  return {
    sqlite, db, calls, insert, count, queries: createQueries(db),
    beforeBatch(hook: () => Promise<void>) { beforeIndexBatch = hook; },
    failBatch() { failIndexBatch = true; },
  };
}

async function main() {
  assert.equal(normalizeLyricsSearchText(" [ar:metadata]\n[00:02.00]歌词<00:03.00>正文", null), "歌词正文");
  assert.equal(normalizeLyricsSearchText('{"t":10,"c":[{"tx":"网易"},{"tx":"歌词"}]}', null), "网易歌词");
  assert.equal(normalizeLyricsSearchQuery("[00:02]歌词"), "[00:02]歌词");
  assert.equal(normalizeLyricsSearchQuery("  ＨＥＬＬＯ\nWORLD  "), "hello world");
  assert.ok(lyricsSearchGrams("月🌙").includes("🌙"));
  assert.equal(normalizeLyricsSearchText(null, '{"tracks":[null,{"line":[null,{"value":3}]}]}'), "");

  const old = fixture(true);
  for (let index = 0; index < 25; index++) old.insert(`old-${String(index).padStart(2, "0")}`, "Old", `existing lyric ${index}`);
  assert.equal(await advanceLyricsSearchIndex(old.db, 12), "building");
  assert.equal(old.count("lyrics_search_documents"), 12);
  assert.equal(await advanceLyricsSearchIndex(old.db, 12), "building");
  assert.equal(await advanceLyricsSearchIndex(old.db, 12), "ready");
  assert.equal(old.count("lyrics_search_documents"), 25);
  const previousCalls = old.calls.length;
  assert.equal(await advanceLyricsSearchIndex(old.db), "ready");
  assert.ok(old.calls.slice(previousCalls).every(({ sql }) => !/INSERT|DELETE|UPDATE|CREATE/u.test(sql)), "ready index performs no rebuild writes");

  const f = fixture();
  f.insert("rain", "夜色回声", "[ti:metadata]\n[00:01]窗外细雨\n[00:04]We follow the northern light");
  f.insert("title", "细雨", "a title match alone");
  f.insert("rich", "远方", null, JSON.stringify({ tracks: [{ kind: "translation", line: [{ value: "月光下的星空" }] }] }));
  f.insert("literal", "百分之百", "100% _ Hello WORLD 🌙", null, 101);
  f.insert("candidate", "Candidate", "abc bcd");
  const ids = async (lyricsQuery: string, query = "") => (await f.queries.search(query, { lyricsQuery, songCount: 100 })).songs.map((song) => song.id);
  assert.deepEqual(await ids("雨"), ["rain"]);
  assert.deepEqual(await ids("细雨"), ["rain"]);
  assert.deepEqual(await ids("NORTHERN LIGHT"), ["rain"]);
  assert.deepEqual(await ids("星空"), ["rich"]);
  assert.deepEqual(await ids("100%"), ["literal"]);
  assert.deepEqual(await ids("_"), ["literal"]);
  assert.deepEqual(await ids("🌙"), ["literal"]);
  assert.deepEqual(await ids("abcd"), [], "candidate gram matches require exact phrase verification");
  assert.deepEqual(await ids("' OR 1=1 --"), []);
  assert.deepEqual(await ids("metadata"), []);
  assert.deepEqual(await ids("细雨", "夜色"), ["rain"]);
  assert.deepEqual(await ids("细雨", "细雨"), []);
  assert.deepEqual((await f.queries.search("细雨")).songs.map((song) => song.id), ["title"]);
  assert.deepEqual((await f.queries.search("细雨", { lyricsQuery: "  " })).songs.map((song) => song.id), ["title"]);
  await assert.rejects(f.queries.search("", { lyricsQuery: "a".repeat(513) }), /too-long/u);
  assert.deepEqual((await f.queries.search("", { lyricsQuery: "e", songCount: 0 })).songs, []);
  const newest = await f.queries.search("", { lyricsQuery: "e", songCount: 1, songSort: "newest" });
  const next = await f.queries.search("", { lyricsQuery: "e", songCount: 1, songOffset: 1, songSort: "newest" });
  assert.equal(newest.songs[0].id, "literal");
  assert.equal(next.songs[0].id, "rain", "equal timestamps use deterministic song id ordering");
  const query = f.calls.findLast(({ sql }) => sql.includes("WITH wanted"))!;
  const plan = f.sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.args);
  assert.ok(plan.some((row) => /SEARCH g USING PRIMARY KEY \(gram=\?\)/u.test(String(row.detail))), "actual search uses the gram primary key");
  const deletePlan = f.sqlite.prepare("EXPLAIN QUERY PLAN DELETE FROM lyrics_search_grams WHERE song_id=?").all("rain");
  assert.ok(deletePlan.some((row) => /idx_lyrics_search_grams_song/u.test(String(row.detail))));

  f.sqlite.exec("UPDATE song_masters SET lyrics=lyrics WHERE id='rain'");
  assert.equal(f.count("lyrics_search_dirty"), 0, "unchanged lyrics do not rebuild");
  f.sqlite.prepare("UPDATE song_masters SET lyrics=? WHERE id='rain'").run("新歌词");
  assert.deepEqual(await ids("细雨"), []);
  assert.deepEqual(await ids("新歌词"), ["rain"]);
  f.sqlite.exec("UPDATE song_masters SET lyrics=NULL WHERE id='rain'");
  assert.deepEqual(await ids("新歌词"), []);
  assert.equal(f.sqlite.prepare("SELECT 1 FROM lyrics_search_documents WHERE song_id='rain'").get(), undefined);
  for (const recursive of [0, 1]) {
    f.sqlite.exec(`PRAGMA recursive_triggers=${recursive}`);
    f.insert("replacement", "Replacement", "旧版本");
    assert.deepEqual(await ids("旧版本"), ["replacement"]);
    f.insert("replacement", "Replacement", "新版本");
    assert.deepEqual(await ids("旧版本"), []);
    assert.deepEqual(await ids("新版本"), ["replacement"]);
    f.sqlite.exec("DELETE FROM song_masters WHERE id='replacement'");
    assert.deepEqual(await ids("新版本"), []);
    assert.equal(f.sqlite.prepare("SELECT 1 FROM lyrics_search_dirty WHERE song_id='replacement'").get(), undefined);
  }

  f.insert("race", "Race", "初始内容");
  await advanceLyricsSearchIndex(f.db);
  f.sqlite.prepare("UPDATE song_masters SET lyrics=? WHERE id='race'").run("较早内容");
  f.beforeBatch(async () => {
    f.sqlite.prepare("UPDATE song_masters SET lyrics=? WHERE id='race'").run("最新内容");
    await advanceLyricsSearchIndex(f.db);
  });
  await advanceLyricsSearchIndex(f.db);
  assert.deepEqual(await ids("最新内容"), ["race"], "stale work cannot overwrite a newer completed batch");
  assert.deepEqual(await ids("较早内容"), []);
  f.sqlite.prepare("UPDATE song_masters SET lyrics=? WHERE id='race'").run("失败后重试");
  f.failBatch();
  await assert.rejects(advanceLyricsSearchIndex(f.db), /simulated/u);
  assert.equal(f.sqlite.prepare("SELECT body FROM lyrics_search_documents WHERE song_id='race'").get()!.body, "最新内容", "failed batch preserves previous document");
  assert.ok(f.count("lyrics_search_dirty") > 0);
  assert.deepEqual(await ids("失败后重试"), ["race"]);

  for (const table of ["lyrics_search_documents", "lyrics_search_grams", "lyrics_search_dirty", "lyrics_search_state"]) {
    assert.deepEqual(f.sqlite.prepare(`PRAGMA table_info(${table})`).all(), old.sqlite.prepare(`PRAGMA table_info(${table})`).all(), "fresh and existing catalogs share schema");
    assert.deepEqual(f.sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all(), old.sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all());
  }
  f.sqlite.close(); old.sqlite.close();
  console.log("PASS: lyrics normalization, indexed SQL search, lifecycle, bounded initialization, transactions and concurrency.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
