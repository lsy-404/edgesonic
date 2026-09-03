import { DatabaseSync } from "node:sqlite";
import { clearLoginFailures, loginAllowed, recordLoginFailure, verifyTurnstile } from "../../worker/src/utils/loginProtection";

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

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ success: true, action: "login", hostname: "app.example" }))) as typeof fetch;
  try {
    const env = { TURNSTILE_SECRET: "secret", TURNSTILE_SITE_KEY: "site" } as Env;
    assert(await verifyTurnstile(env, request, "token", "login"), "accepts a matching Siteverify result");
    assert(!(await verifyTurnstile(env, request, "token", "register")), "rejects a token issued for another action");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert(await verifyTurnstile({} as Env, request, undefined, "login"), "unconfigured Turnstile stays optional");
  console.log("Login protection checks passed");
}

main();
