// Route-level regression checks for clone proxy target validation and RPM control.
import { Hono } from "hono";
import { cloneRoutes } from "../../worker/src/endpoints/edgesonic/clone";

declare global { type D1Database = unknown; type D1PreparedStatement = unknown; type Env = unknown; }

let failures = 0;
function assert(value: unknown, message: string) { if (value) console.log(`  ✓ ${message}`); else { failures++; console.error(`  ✗ ${message}`); } }

function db() {
  const counts = new Map<string, number>();
  return {
    prepare(sql: string) {
      const statement = {
        values: [] as unknown[],
        bind(...values: unknown[]) { statement.values = values; return statement; },
        async run() { return { success: true, meta: {} }; },
        async first<T>() {
          if (sql.includes("RETURNING count")) {
            const key = `${statement.values[0]}:${statement.values[1]}`;
            const count = (counts.get(key) || 0) + 1;
            counts.set(key, count);
            return { count } as T;
          }
          return null;
        },
      };
      return statement;
    },
  };
}

async function main() {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => { c.set("user", { username: "user", level: 0 }); return next(); });
  app.route("/edgesonic", cloneRoutes);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("{}", { headers: { "Content-Type": "application/json" } }); }) as typeof fetch;
  try {
    const env = { DB: db() };
    const post = (body: Record<string, unknown>) => app.fetch(new Request("https://app.test/edgesonic/clone/proxy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), env);
    const base = { upstreamUrl: "https://music.example.test", username: "up", password: "pw", path: "getAlbum", params: {} };
    const blocked = await post({ ...base, upstreamUrl: "http://127.0.0.1" });
    assert(blocked.status === 400 && calls === 0, "route rejects IP-literal targets before fetch");
    const forbiddenPath = await post({ ...base, path: "star" });
    assert(forbiddenPath.status === 400 && calls === 0, "route permits only read-only Subsonic paths");
    const first = await post(base);
    assert(first.status === 200 && calls === 1, "route proxies an allowed HTTPS read request");
    let last: Response | undefined;
    for (let i = 0; i < 30; i++) last = await post(base);
    assert(last?.status === 429 && last.headers.has("Retry-After"), "persistent minute counter returns 429 and Retry-After");
  } finally { globalThis.fetch = originalFetch; }
  process.exit(failures ? 1 : 0);
}
main();
