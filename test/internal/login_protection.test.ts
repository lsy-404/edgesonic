import { DatabaseSync } from "node:sqlite";
import { clearLoginFailures, loginAllowed, recordLoginFailure } from "../../worker/src/utils/loginProtection";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function makeD1(sqlite: DatabaseSync): D1Database {
  return {
    prepare(query: string) {
      const statement = sqlite.prepare(query);
      let values: unknown[] = [];
      return {
        bind(...next: unknown[]) { values = next; return this; },
        async first<T>() { return (statement.get(...values) ?? null) as T | null; },
        async run() { statement.run(...values); return { success: true, meta: {} }; },
      };
    },
  } as unknown as D1Database;
}

async function main() {
  const db = makeD1(new DatabaseSync(":memory:"));
  const request = new Request("https://app.example/edgesonic/auth/login", {
    headers: { "CF-Connecting-IP": "203.0.113.10" },
  });

  for (let attempt = 0; attempt < 5; attempt++) await recordLoginFailure(db, request, "alice");
  assert((await loginAllowed(db, request, "alice")) > 0, "five failures persist a D1-backed lock");
  await clearLoginFailures(db, request, "alice");
  assert((await loginAllowed(db, request, "alice")) === 0, "successful login clears the matching lock");

  console.log("Login protection checks passed");
}

main();
