// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { workRoutes } from "../../worker/src/endpoints/edgesonic/work";

function makeApp() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE work_queue (
      id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL,
      claimed_by TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      priority INTEGER NOT NULL DEFAULT 5,
      created_at INTEGER NOT NULL DEFAULT 0,
      heartbeat_at INTEGER,
      error_message TEXT
    );
    INSERT INTO work_queue (id, task_type, status, claimed_by, created_at, heartbeat_at) VALUES
      ('q1', 'metadata', 'queued', NULL, 100, NULL),
      ('c1', 'metadata', 'claimed', 'admin', 101, 101),
      ('d1', 'metadata', 'completed', 'admin', 102, 102),
      ('f1', 'metadata', 'failed', NULL, 103, NULL);
  `);

  const queries: string[] = [];
  const env = {
    DB: {
      prepare(query: string) {
        const statement = sqlite.prepare(query);
        let args: unknown[] = [];
        return {
          bind(...values: unknown[]) { args = values; return this; },
          async all<T = unknown>() {
            queries.push(query);
            return { results: statement.all(...args) as T[], success: true as const, meta: {} };
          },
        };
      },
    },
  };
  const app = new Hono<{ Bindings: typeof env; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "admin", level: 3, enabled: 1, password: "x" } as any);
    c.set("authMethod", "session" as any);
    await next();
  });
  app.route("/edgesonic", workRoutes);
  return { app, env, queries, sqlite };
}

async function main() {
  {
    const { app, env, queries, sqlite } = makeApp();
    const response = await app.fetch(new Request("http://test/edgesonic/work/status?countsOnly=1"), env);
    const body = await response.json() as { ok: boolean; counts: Record<string, number> };

    assert.equal(response.status, 200);
    assert.deepEqual(body.counts, { queued: 1, claimed: 1, completed: 1, failed: 1, canceled: 0 });
    assert.equal(queries.length, 1);
    assert.match(queries[0], /SELECT status, COUNT\(\*\) AS n FROM work_queue GROUP BY status/);
    sqlite.close();
  }

  {
    const { app, env, queries, sqlite } = makeApp();
    const response = await app.fetch(new Request("http://test/edgesonic/work/status"), env);
    const body = await response.json() as { ok: boolean; counts: Record<string, number>; load: unknown[]; recent: unknown[] };

    assert.equal(response.status, 200);
    assert.deepEqual(body.counts, { queued: 1, claimed: 1, completed: 1, failed: 1, canceled: 0 });
    assert.ok(Array.isArray(body.load));
    assert.ok(Array.isArray(body.recent));
    assert.equal(queries.length, 3);
    sqlite.close();
  }

  console.log("work status summary tests passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
