import { DatabaseSync } from "node:sqlite";
import { advanceLyricsSearchIndex, findLyricsSongIds, syncLyricsSearchForSong } from "../../worker/src/utils/lyricsSearch";

let failures = 0;
function assert(value: unknown, message: string) {
  if (value) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

function makeD1(sqlite: DatabaseSync): D1Database {
  const prepare = (sql: string) => {
    const statement = sqlite.prepare(sql);
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) { args = values; return this; },
      async first<T>(): Promise<T | null> { return (statement.get(...args) ?? null) as T | null; },
      async all<T>(): Promise<{ results: T[] }> { return { results: statement.all(...args) as T[] }; },
      async run() { const result = statement.run(...args); return { meta: { changes: Number(result.changes) } }; },
    };
  };
  return { prepare, batch: async (statements: Array<{ run: () => Promise<unknown> }>) => Promise.all(statements.map((statement) => statement.run())) } as unknown as D1Database;
}

async function run() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE song_masters (id TEXT PRIMARY KEY, lyrics TEXT, lyrics_rich TEXT)");
  sqlite.prepare("INSERT INTO song_masters VALUES (?, ?, ?)").run("one", "[ti:ignored]\n[00:01.20]月亮照进心房", null);
  sqlite.prepare("INSERT INTO song_masters VALUES (?, ?, ?)").run("two", "plain English lyric", JSON.stringify({ tracks: [{ line: [{ value: "翻译的月光" }], cueLine: [], agents: [] }] }));
  const db = makeD1(sqlite);

  assert(await advanceLyricsSearchIndex(db, 12) === "ready", "bounded initial batch reaches ready state");
  assert(JSON.stringify(await findLyricsSongIds(db, "月")) === '["one","two"]', "one-character Chinese query uses gram index");
  assert(JSON.stringify(await findLyricsSongIds(db, "心房")) === '["one"]', "two-character Chinese substring matches");
  assert(JSON.stringify(await findLyricsSongIds(db, "english lyric")) === '["two"]', "English phrase matches continuously");
  assert(JSON.stringify(await findLyricsSongIds(db, "ignored")) === "[]", "LRC metadata is excluded");
  assert(JSON.stringify(await findLyricsSongIds(db, "翻译")) === '["two"]', "rich translation values are indexed");

  sqlite.prepare("UPDATE song_masters SET lyrics = NULL WHERE id = 'one'").run();
  await syncLyricsSearchForSong(db, "one");
  assert(JSON.stringify(await findLyricsSongIds(db, "心房")) === "[]", "clearing lyrics removes index entries");
  sqlite.prepare("DELETE FROM song_masters WHERE id = 'two'").run();
  await syncLyricsSearchForSong(db, "two");
  assert(JSON.stringify(await findLyricsSongIds(db, "english")) === "[]", "deleting a song removes index entries");
  process.exitCode = failures ? 1 : 0;
}

void run();
