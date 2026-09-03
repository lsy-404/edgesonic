// SPDX-License-Identifier: AGPL-3.0-or-later

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { authMiddleware, sha256 } from "../../worker/src/auth";
import { edgesonicAuthRoutes } from "../../worker/src/endpoints/edgesonic/auth";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

declare global { type D1Database = unknown; type Env = unknown; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeD1(sqlite: DatabaseSync): any {
  function prepare(query: string) {
    const statement = sqlite.prepare(query);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let args: any[] = [];
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bind(...values: any[]) { args = values; return this; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async first<T = any>(): Promise<T | null> { return (statement.get(...args) ?? null) as T | null; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async all<T = any>(): Promise<{ results: T[]; success: true; meta: any }> {
        return { results: statement.all(...args) as T[], success: true, meta: {} };
      },
      async run() {
        const result = statement.run(...args);
        return { success: true, meta: { changes: Number(result.changes ?? 0) } };
      },
    };
  }
  return { prepare };
}

async function buildDb(): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE users (
      username TEXT PRIMARY KEY, master_password TEXT, level INTEGER NOT NULL, enabled INTEGER DEFAULT 1,
      avatar_r2_key TEXT, nickname TEXT, email TEXT, email_verified INTEGER NOT NULL DEFAULT 0,
      subsonic_master_password_notice_at INTEGER
    );
    CREATE TABLE api_keys (api_key TEXT PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE subsonic_credentials (username TEXT NOT NULL, password TEXT NOT NULL, stream_proxy_strategy TEXT, last_used INTEGER, expires_at INTEGER);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, username TEXT NOT NULL, token TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE user_permissions (level INTEGER NOT NULL, permission TEXT NOT NULL, enabled INTEGER DEFAULT 0, max_rph INTEGER DEFAULT 0, PRIMARY KEY (level, permission));
    CREATE TABLE guest_tokens (token TEXT PRIMARY KEY, expires_at INTEGER);
    INSERT INTO user_permissions (level, permission, enabled) VALUES (2, 'manage_credentials', 1), (1, 'manage_credentials', 0);
  `);
  sqlite.prepare("INSERT INTO users (username, master_password, level, enabled) VALUES (?, ?, ?, 1)")
    .run("allowed", await sha256("account-password"), 2);
  sqlite.prepare("INSERT INTO users (username, master_password, level, enabled) VALUES (?, ?, ?, 1)")
    .run("blocked", await sha256("blocked-password"), 1);
  sqlite.prepare("INSERT INTO users (username, master_password, level, enabled) VALUES (?, ?, ?, 1)")
    .run("with-client-password", await sha256("other-account-password"), 2);
  sqlite.prepare("INSERT INTO subsonic_credentials (username, password, stream_proxy_strategy) VALUES (?, ?, 'always')")
    .run("with-client-password", "client-password");
  return sqlite;
}

function makeApp(sqlite: DatabaseSync) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("/rest/*", authMiddleware);
  app.get("/rest/ping", (c) => c.json({ ok: true, authMethod: c.get("authMethod") }));
  const env = { DB: makeD1(sqlite) };
  return async (params: Record<string, string>) => {
    const query = new URLSearchParams(params);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return app.fetch(new Request(`http://test/rest/ping?${query}`), env as any);
  };
}

function makeMainSiteApp(sqlite: DatabaseSync, user: { username: string; level: number }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("/edgesonic/*", async (c, next) => {
    c.set("user", { ...user, enabled: 1, password: "x" });
    return next();
  });
  app.route("/edgesonic", edgesonicAuthRoutes);
  const env = { DB: makeD1(sqlite) };
  return async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return app.fetch(new Request("http://test/edgesonic/auth/me"), env as any);
  };
}

function pendingNotice(sqlite: DatabaseSync, username: string): number | null {
  const row = sqlite.prepare(
    "SELECT subsonic_master_password_notice_at FROM users WHERE username = ?",
  ).get(username) as { subsonic_master_password_notice_at: number | null };
  return row.subsonic_master_password_notice_at;
}

async function main() {
  console.log("Primary password with no client passwords → generic protocol rejection + pending main-site notice:");
  {
    const sqlite = await buildDb();
    const get = makeApp(sqlite);
    const response = await get({ u: "allowed", p: "account-password" });
    const body = await response.text();
    assert(response.status === 401, `401 (got ${response.status})`);
    assert(/Wrong username or password/.test(body), "keeps the Subsonic error generic");
    assert(pendingNotice(sqlite, "allowed") !== null, "records a one-time main-site notice");
  }

  console.log("Encoded primary password with no client passwords → also records a notice:");
  {
    const sqlite = await buildDb();
    const get = makeApp(sqlite);
    const response = await get({ u: "allowed", p: `enc:${Buffer.from("account-password", "utf8").toString("hex")}` });
    const body = await response.text();
    assert(response.status === 401, `401 (got ${response.status})`);
    assert(/Wrong username or password/.test(body), "keeps the encoded-password rejection generic");
    assert(pendingNotice(sqlite, "allowed") !== null, "decodes enc: before recording the notice");
  }

  console.log("Next main-site visit returns the allowed-account notice once, then consumes it:");
  {
    const sqlite = await buildDb();
    await makeApp(sqlite)({ u: "allowed", p: "account-password" });
    const getMe = makeMainSiteApp(sqlite, { username: "allowed", level: 2 });
    const first = await (await getMe()).json() as { subsonicMasterPasswordNotice?: string | null };
    const second = await (await getMe()).json() as { subsonicMasterPasswordNotice?: string | null };
    assert(first.subsonicMasterPasswordNotice === "create_client_password", `returns the client-password guidance code (got ${String(first.subsonicMasterPasswordNotice)})`);
    assert(second.subsonicMasterPasswordNotice === null, "consumes the notice after it is delivered");
    assert(pendingNotice(sqlite, "allowed") === null, `clears the persisted notice (got ${String(pendingNotice(sqlite, "allowed"))})`);
  }

  console.log("Next main-site visit returns the administrator-policy code for an ineligible account:");
  {
    const sqlite = await buildDb();
    await makeApp(sqlite)({ u: "blocked", p: "blocked-password" });
    const getMe = makeMainSiteApp(sqlite, { username: "blocked", level: 1 });
    const body = await (await getMe()).json() as { subsonicMasterPasswordNotice?: string | null };
    assert(body.subsonicMasterPasswordNotice === "clients_not_enabled", `returns the administrator-policy guidance code (got ${String(body.subsonicMasterPasswordNotice)})`);
  }

  console.log("Existing client passwords suppress primary-password verification and leave no notice:");
  {
    const sqlite = await buildDb();
    const get = makeApp(sqlite);
    const rejected = await get({ u: "with-client-password", p: "other-account-password" });
    const response = await get({ u: "with-client-password", p: "client-password" });
    const body = await response.json() as { authMethod?: string };
    assert(rejected.status === 401, `primary password still rejected (got ${rejected.status})`);
    assert(pendingNotice(sqlite, "with-client-password") === null, "does not test or record a notice when any client password exists");
    assert(response.status === 200, `client password 200 (got ${response.status})`);
    assert(body.authMethod === "subsonic_cred", `authMethod=subsonic_cred (got ${body.authMethod})`);
  }

  console.log("An unrelated bad password remains generic and does not create a notice:");
  {
    const sqlite = await buildDb();
    const response = await makeApp(sqlite)({ u: "allowed", p: "wrong-password" });
    const body = await response.text();
    assert(response.status === 401, `401 (got ${response.status})`);
    assert(/Wrong username or password/.test(body), "keeps the generic failure response");
    assert(pendingNotice(sqlite, "allowed") === null, "does not create a notice for an unverified password");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
