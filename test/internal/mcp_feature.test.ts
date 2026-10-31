import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { featuresRoutes } from "../../worker/src/endpoints/edgesonic/features";

test("existing databases expose one disabled MCP switch and can enable it without provisioning", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE features (key TEXT PRIMARY KEY, value INTEGER, description TEXT, updated_at INTEGER); CREATE TABLE feature_strings (key TEXT PRIMARY KEY, value TEXT, description TEXT, updated_at INTEGER);");
  const db = { prepare(sql: string) {
    let args: unknown[] = [];
    const statement = sqlite.prepare(sql);
    return {
      bind(...values: unknown[]) { args = values; return this; },
      async all() { return { results: statement.all(...args as never[]) }; },
      async run() { return { meta: { changes: Number(statement.run(...args as never[]).changes) } }; },
    };
  } };
  const app = new Hono<{ Variables: { user: { username: string; level: number; enabled: number }; authMethod: string } }>();
  let level = 3;
  app.use("*", async (c, next) => { c.set("user", { username: "fixture", level, enabled: 1 }); c.set("authMethod", "session"); return next(); });
  app.route("/edgesonic", featuresRoutes);
  const env = { DB: db, INSTANCE_ID: "fixture" };
  const list = () => app.fetch(new Request("https://example.com/edgesonic/features/list"), env);
  const update = (key: string, value: number, demo = false) => app.fetch(new Request("https://example.com/edgesonic/features/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value }) }), { ...env, ...(demo ? { DEMO_MODE: "1" } : {}) });
  const initial = await (await list()).json() as { features: Array<{ key: string; value: number }> };
  assert.deepEqual(initial.features, [{ key: "mcp_enabled", value: 0, description: "Enable authenticated MCP library management", updated_at: 0 }]);
  assert.equal((await update("mcp_enabled", 1)).status, 200);
  assert.equal(sqlite.prepare("SELECT value FROM features WHERE key='mcp_enabled'").get()?.value, 1);
  assert.equal((await update("mcp_enabled", 0)).status, 200);
  assert.equal(sqlite.prepare("SELECT value FROM features WHERE key='mcp_enabled'").get()?.value, 0);
  assert.equal((await update("mcp_enabled", 1, true)).status, 403);
  assert.equal((await update("unknown_feature", 1)).status, 404);
  const after = await (await list()).json() as { features: Array<{ key: string }> };
  assert.equal(after.features.filter(row => row.key === "mcp_enabled").length, 1);
  level = 1;
  assert.equal((await update("mcp_enabled", 1)).status, 403);
  sqlite.close();
});
