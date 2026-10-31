import { DatabaseSync } from "node:sqlite";
export function sqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE features (key TEXT PRIMARY KEY, value INTEGER NOT NULL); CREATE TABLE users (username TEXT PRIMARY KEY, master_password TEXT, level INTEGER, enabled INTEGER, activation_status TEXT)");
  const db = { prepare(sql: string) {
    let args: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) { args = values; return statement; },
      async first() { return sqlite.prepare(sql).get(...args as never[]) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...args as never[]) }; },
      async run() { const result = sqlite.prepare(sql).run(...args as never[]); return { meta: { changes: Number(result.changes) } }; },
    };
    return statement;
  } } as unknown as D1Database;
  return { sqlite, db };
}
