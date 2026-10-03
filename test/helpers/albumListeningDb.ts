import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function createDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../../worker/migrations/Schema.sql", import.meta.url), "utf8"));
  return sqlite;
}

export function makeD1(sqlite: DatabaseSync): D1Database {
  return {
    prepare(query: string) {
      const statement = sqlite.prepare(query);
      let args: unknown[] = [];
      return {
        bind(...bound: unknown[]) {
          args = bound;
          return this;
        },
        async first<T = unknown>() {
          return (statement.get(...args) as T | undefined) ?? null;
        },
        async all<T = unknown>() {
          return { results: statement.all(...args) as T[], success: true, meta: {} };
        },
        async run() {
          const result = statement.run(...args);
          return { success: true, meta: { changes: Number(result.changes ?? 0) } };
        },
      };
    },
  } as unknown as D1Database;
}
