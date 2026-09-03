import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { messagesRoutes } from "../../worker/src/endpoints/edgesonic/messages";

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

function buildDb() {
  const sqlite = new DatabaseSync(":memory:");
  const soon = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60;
  sqlite.exec(`
    CREATE TABLE users (
      username TEXT PRIMARY KEY, level INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      activation_status TEXT NOT NULL DEFAULT 'permanent', activated_until INTEGER
    );
    CREATE TABLE user_permissions (level INTEGER NOT NULL, permission TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (level, permission));
    CREATE TABLE user_messages (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL,
      presentation TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, dedupe_key TEXT,
      read_at INTEGER, dismissed_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_user_messages_dedupe ON user_messages(username, dedupe_key) WHERE dedupe_key IS NOT NULL;
    INSERT INTO users (username, level) VALUES ('root', 3), ('admin', 2), ('alice', 1);
    INSERT INTO users (username, level, activation_status, activated_until) VALUES ('soon', 1, 'active_until', ${soon});
    INSERT INTO user_permissions (level, permission, enabled) VALUES (2, 'manage_users', 1), (1, 'manage_users', 0);
  `);
  return sqlite;
}

function makeApp(sqlite: DatabaseSync, caller: { username: string; level: number; activation_status?: string; activated_until?: number | null }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { enabled: 1, password: "x", ...caller });
    return next();
  });
  app.route("/edgesonic", messagesRoutes);
  const env = { DB: makeD1(sqlite) };
  return {
    async get(path: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return app.fetch(new Request(`http://test${path}`), env as any);
    },
    async post(path: string, body: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return app.fetch(new Request(`http://test${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }), env as any);
    },
  };
}

async function main() {
  console.log("Admin sends an inbox message to a normal user:");
  {
    const sqlite = buildDb();
    const admin = makeApp(sqlite, { username: "admin", level: 2 });
    const sent = await admin.post("/edgesonic/messages/send", {
      username: "alice", title: "Library maintenance", message: "Uploads pause tonight.", kind: "info", presentation: "inbox",
    });
    assert(sent.status === 200, `200 (got ${sent.status})`);
    const alice = makeApp(sqlite, { username: "alice", level: 1 });
    const body = await (await alice.get("/edgesonic/messages")).json() as { messages: Array<{ title: string; kind: string; presentation: string }> };
    assert(body.messages.some((message) => message.title === "Library maintenance" && message.kind === "info" && message.presentation === "inbox"), "recipient receives the typed inbox message");
  }

  console.log("Lower-tier administrators cannot send a message to administrators:");
  {
    const sqlite = buildDb();
    const admin = makeApp(sqlite, { username: "admin", level: 2 });
    const response = await admin.post("/edgesonic/messages/send", {
      username: "root", title: "Hi", message: "No escalation", kind: "notice", presentation: "modal",
    });
    assert(response.status === 403, `403 (got ${response.status})`);
  }

  console.log("Read and dismiss are scoped to the recipient:");
  {
    const sqlite = buildDb();
    const root = makeApp(sqlite, { username: "root", level: 3 });
    await root.post("/edgesonic/messages/send", {
      username: "alice", title: "Action needed", message: "Please review this.", kind: "notice", presentation: "modal",
    });
    const id = (sqlite.prepare("SELECT id FROM user_messages WHERE username = 'alice'").get() as { id: string }).id;
    const admin = makeApp(sqlite, { username: "admin", level: 2 });
    await admin.post("/edgesonic/messages/dismiss", { id });
    assert((sqlite.prepare("SELECT dismissed_at FROM user_messages WHERE id = ?").get(id) as { dismissed_at: number | null }).dismissed_at === null, "another user cannot dismiss it");
    const alice = makeApp(sqlite, { username: "alice", level: 1 });
    await alice.post("/edgesonic/messages/dismiss", { id });
    const row = sqlite.prepare("SELECT dismissed_at, read_at FROM user_messages WHERE id = ?").get(id) as { dismissed_at: number | null; read_at: number | null };
    assert(row.dismissed_at !== null && row.read_at !== null, "recipient dismissal marks it read and dismissed");
  }

  console.log("An account nearing activation expiry receives one warning modal:");
  {
    const sqlite = buildDb();
    const until = sqlite.prepare("SELECT activated_until FROM users WHERE username = 'soon'").get() as { activated_until: number };
    const app = makeApp(sqlite, { username: "soon", level: 1, activation_status: "active_until", activated_until: until.activated_until });
    const first = await (await app.get("/edgesonic/messages")).json() as { messages: Array<{ kind: string; presentation: string; source: string }> };
    await app.get("/edgesonic/messages");
    const count = sqlite.prepare("SELECT COUNT(*) AS n FROM user_messages WHERE username = 'soon'").get() as { n: number };
    assert(first.messages.some((message) => message.source === "system" && message.kind === "warning" && message.presentation === "modal"), "expiry warning is modal-capable");
    assert(count.n === 1, "expiry warning is deduplicated for the same end time");
  }

  console.log("The latest GitHub release becomes an official super-admin message:");
  {
    const sqlite = buildDb();
    const originalFetch = global.fetch;
    global.fetch = (async () => new Response(JSON.stringify({
      tag_name: "v9.9.9", name: "Security patch", body: "Apply this patch now.", published_at: "2026-09-03T00:00:00Z",
    }), { headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      const root = makeApp(sqlite, { username: "root", level: 3 });
      const body = await (await root.get("/edgesonic/messages")).json() as { officialMessages: Array<{ source: string; title: string; presentation: string }> };
      assert(body.officialMessages.some((message) => message.source === "official" && message.title.includes("Security patch") && message.presentation === "modal"), "GitHub release is delivered as an official modal message");
    } finally {
      global.fetch = originalFetch;
    }
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
