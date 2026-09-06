import { DatabaseSync } from "node:sqlite";
import { advanceLyricsSearchIndex, lyricsSearchGrams, normalizeLyricsSearchQuery, normalizeLyricsSearchText } from "../../worker/src/utils/lyricsSearch";

let failures = 0;
function assert(value: unknown, message: string) { if (value) console.log(`  ✓ ${message}`); else { failures++; console.error(`  ✗ ${message}`); } }
function d1(sqlite: DatabaseSync): D1Database {
  const prepare = (sql: string) => { const statement = sqlite.prepare(sql); let args: unknown[] = []; return { bind(...values: unknown[]) { args = values; return this; }, async first<T>() { return (statement.get(...args) ?? null) as T | null; }, async all<T>() { return { results: statement.all(...args) as T[] }; }, async run() { const info = statement.run(...args); return { meta: { changes: Number(info.changes) } }; } }; };
  return { prepare, batch: async (items: Array<{ run(): Promise<unknown> }>) => Promise.all(items.map((item) => item.run())) } as unknown as D1Database;
}
async function run() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE song_masters(id TEXT PRIMARY KEY, lyrics TEXT, lyrics_rich TEXT); INSERT INTO song_masters VALUES('a','[ti:meta]\\n[00:01.00]月亮照进心房',NULL),('b','plain English lyric',NULL),('c',NULL,'{\"tracks\":[{\"line\":[{\"value\":\"翻译月光\"}]}]}');");
  const db = d1(sqlite);
  assert(normalizeLyricsSearchText("[ar:x]\n[00:02]歌词", null) === "歌词", "drops LRC metadata and timestamps");
  assert(normalizeLyricsSearchQuery("[00:02]歌词") === "[00:02]歌词", "query remains a literal value");
  assert(lyricsSearchGrams("心房").includes("心房"), "builds two-character gram");
  assert(await advanceLyricsSearchIndex(db, 2) === "building", "initializes in bounded batches");
  assert(await advanceLyricsSearchIndex(db, 2) === "ready", "retries until dirty queue drains");
  const plan = sqlite.prepare("EXPLAIN QUERY PLAN SELECT song_id FROM lyrics_search_grams WHERE gram='心房'").all() as Array<{ detail: string }>;
  assert(plan.some((row) => /PRIMARY KEY|lyrics_search_grams/i.test(row.detail)), "gram lookup uses an index");
  sqlite.prepare("UPDATE song_masters SET lyrics=NULL WHERE id='a'").run();
  await advanceLyricsSearchIndex(db);
  assert((sqlite.prepare("SELECT COUNT(*) n FROM lyrics_search_documents WHERE song_id='a'").get() as { n: number }).n === 0, "NULL update removes document");
  sqlite.prepare("DELETE FROM song_masters WHERE id='b'").run();
  assert((sqlite.prepare("SELECT COUNT(*) n FROM lyrics_search_grams WHERE song_id='b'").get() as { n: number }).n === 0, "DELETE trigger removes grams");
  process.exitCode = failures ? 1 : 0;
}
void run();
