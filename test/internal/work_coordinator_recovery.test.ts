// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

type Claim = { id: string; attempts: number; claimedAt: number };
type Attachment = {
  username: string;
  caps: string[];
  maxConcurrent: number;
  holding: Claim[];
  joinedAt: number;
};

class FakeSocket {
  static readonly READY_STATE_OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  failSend = false;
  constructor(public attachment: Attachment, public lastPing: Date | null) {}
  deserializeAttachment() { return structuredClone(this.attachment); }
  serializeAttachment(value: Attachment) { this.attachment = structuredClone(value); }
  send(value: string) {
    if (this.failSend) throw new Error("send failed");
    this.sent.push(value);
  }
  close() { this.readyState = 3; }
}

class FakeState {
  sockets: FakeSocket[] = [];
  alarmAt: number | null = null;
  storage = {
    getAlarm: async () => this.alarmAt,
    setAlarm: async (time: number) => { this.alarmAt = time; },
  };
  setWebSocketAutoResponse() {}
  getWebSockets() { return this.sockets; }
  getWebSocketAutoResponseTimestamp(socket: FakeSocket) { return socket.lastPing; }
}

function makeDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE feature_strings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE work_queue (
      id TEXT PRIMARY KEY, task_type TEXT NOT NULL, payload TEXT NOT NULL,
      required_caps TEXT, priority INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL, claimed_by TEXT, claimed_at INTEGER,
      heartbeat_at INTEGER, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
      created_at INTEGER NOT NULL, error_message TEXT
    );
  `);
  let afterStaleSelect: (() => void) | undefined;
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let args: Array<string | number | null> = [];
      return {
        bind(...values: Array<string | number | null>) { args = values; return this; },
        async all<T>() {
          const results = statement.all(...args) as T[];
          if (sql.includes("SELECT id, attempts, max_attempts") && afterStaleSelect) {
            const mutate = afterStaleSelect;
            afterStaleSelect = undefined;
            mutate();
          }
          return { results };
        },
        async first<T>() { return (statement.get(...args) ?? null) as T | null; },
        async run() {
          const result = statement.run(...args);
          return { meta: { changes: Number(result.changes) } };
        },
      };
    },
    async batch(statements: Array<{ run(): Promise<{ meta: { changes: number } }> }>) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  return { sqlite, db, setAfterStaleSelect(callback: () => void) { afterStaleSelect = callback; } };
}

function seed(sqlite: DatabaseSync, id: string, status: string, ageSeconds: number, attempts = 1) {
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO work_queue
    (id,task_type,payload,required_caps,priority,status,claimed_by,claimed_at,
     heartbeat_at,attempts,max_attempts,created_at)
    VALUES (?,'metadata','{}',NULL,5,?,?,?,?,?,3,?)`)
    .run(id, status, status === "claimed" ? "admin" : null,
      status === "claimed" ? now - ageSeconds : null,
      status === "claimed" ? now - ageSeconds : null, attempts, now - 300);
}

async function main() {
  (globalThis as Record<string, unknown>).WebSocket = FakeSocket;
  (globalThis as Record<string, unknown>).WebSocketRequestResponsePair = class {
    constructor(_request: string, _response: string) {}
  };
  const [{ WorkCoordinator }, { reclaimStaleWork }] = await Promise.all([
    import("../../worker/src/coordinator/workCoordinator"),
    import("../../worker/src/utils/workReclaim"),
  ]);

  {
    const { sqlite, db, setAfterStaleSelect } = makeDatabase();
    seed(sqlite, "heartbeat-race", "claimed", 120);
    setAfterStaleSelect(() => sqlite.prepare("UPDATE work_queue SET heartbeat_at = unixepoch() WHERE id = ?")
      .run("heartbeat-race"));
    const report = await reclaimStaleWork({ DB: db } as unknown as Env, false);
    assert.equal(report.scanned, 1);
    assert.equal(report.reQueued, 0);
    assert.equal((sqlite.prepare("SELECT status FROM work_queue WHERE id = ?")
      .get("heartbeat-race") as { status: string }).status, "claimed");
    sqlite.close();
  }

  {
    const { sqlite, db, setAfterStaleSelect } = makeDatabase();
    seed(sqlite, "submit-race", "claimed", 120);
    setAfterStaleSelect(() => sqlite.prepare("UPDATE work_queue SET status = 'completed' WHERE id = ?")
      .run("submit-race"));
    const report = await reclaimStaleWork({ DB: db } as unknown as Env, false);
    assert.equal(report.scanned, 1);
    assert.equal(report.reQueued, 0);
    assert.equal((sqlite.prepare("SELECT status FROM work_queue WHERE id = ?")
      .get("submit-race") as { status: string }).status, "completed");
    sqlite.close();
  }

  {
    const { sqlite, db } = makeDatabase();
    seed(sqlite, "lost-done", "claimed", 120);
    const state = new FakeState();
    const now = Math.floor(Date.now() / 1000);
    const socket = new FakeSocket({
      username: "admin", caps: [], maxConcurrent: 1,
      holding: [{ id: "lost-done", attempts: 1, claimedAt: now - 120 }], joinedAt: now,
    }, new Date());
    state.sockets.push(socket);
    const coordinator = new WorkCoordinator(state as unknown as DurableObjectState,
      { DB: db } as unknown as Env);
    await coordinator.alarm();
    assert.equal(socket.attachment.holding.length, 1);
    assert.equal(socket.attachment.holding[0].id, "lost-done");
    assert.equal(socket.attachment.holding[0].attempts, 2);
    assert.equal(socket.attachment.holding[0].claimedAt, now);
    assert.equal(socket.sent.length, 1);
    assert.ok(state.alarmAt && state.alarmAt > Date.now());
    sqlite.close();
  }

  {
    const { sqlite, db } = makeDatabase();
    seed(sqlite, "ghost-job", "claimed", 120);
    const state = new FakeState();
    const now = Math.floor(Date.now() / 1000);
    const ghost = new FakeSocket({
      username: "admin", caps: [], maxConcurrent: 1,
      holding: [{ id: "ghost-job", attempts: 1, claimedAt: now - 120 }], joinedAt: now - 120,
    }, new Date(Date.now() - 120_000));
    const live = new FakeSocket({
      username: "admin", caps: [], maxConcurrent: 1, holding: [], joinedAt: now,
    }, new Date());
    state.sockets.push(ghost, live);
    const coordinator = new WorkCoordinator(state as unknown as DurableObjectState,
      { DB: db } as unknown as Env);
    await coordinator.alarm();
    assert.equal(ghost.readyState, 3);
    assert.equal(ghost.sent.length, 0);
    assert.equal(live.sent.length, 1);
    assert.equal(live.attachment.holding[0].attempts, 2);
    sqlite.close();
  }

  {
    const { sqlite, db } = makeDatabase();
    seed(sqlite, "last-ghost", "claimed", 60);
    const state = new FakeState();
    const now = Math.floor(Date.now() / 1000);
    const ghost = new FakeSocket({
      username: "admin", caps: [], maxConcurrent: 1,
      holding: [{ id: "last-ghost", attempts: 1, claimedAt: now - 60 }],
      joinedAt: now - 60,
    }, new Date(Date.now() - 60_000));
    state.sockets.push(ghost);
    const coordinator = new WorkCoordinator(state as unknown as DurableObjectState,
      { DB: db } as unknown as Env);
    await coordinator.alarm();
    const first = sqlite.prepare("SELECT status FROM work_queue WHERE id = ?")
      .get("last-ghost") as { status: string };
    assert.equal(first.status, "claimed", "claim at the exact TTL boundary stays claimed");
    assert.ok(state.alarmAt && state.alarmAt > Date.now(), "another alarm is scheduled while a claim remains");
    sqlite.prepare("UPDATE work_queue SET heartbeat_at = heartbeat_at - 1 WHERE id = ?").run("last-ghost");
    await coordinator.alarm();
    const row = sqlite.prepare("SELECT status, attempts FROM work_queue WHERE id = ?")
      .get("last-ghost") as { status: string; attempts: number };
    assert.equal(ghost.readyState, 3);
    assert.equal(row.status, "queued", "last ghost is reclaimed even when no socket remains");
    assert.equal(row.attempts, 1);
    sqlite.close();
  }

  {
    const { sqlite, db } = makeDatabase();
    seed(sqlite, "late-done", "claimed", 0, 2);
    const state = new FakeState();
    const now = Math.floor(Date.now() / 1000);
    const socket = new FakeSocket({
      username: "admin", caps: [], maxConcurrent: 1,
      holding: [{ id: "late-done", attempts: 2, claimedAt: now }], joinedAt: now,
    }, new Date());
    state.sockets.push(socket);
    const coordinator = new WorkCoordinator(state as unknown as DurableObjectState,
      { DB: db } as unknown as Env);
    await coordinator.webSocketMessage(socket as unknown as WebSocket,
      JSON.stringify({ type: "done", id: "late-done", attempts: 1, claimedAt: now - 120 }));
    assert.equal(socket.attachment.holding.length, 1, "late completion cannot release a newer local claim");
    sqlite.close();
  }

  {
    const { sqlite, db } = makeDatabase();
    seed(sqlite, "send-failure", "queued", 0, 0);
    const state = new FakeState();
    const socket = new FakeSocket({
      username: "admin", caps: [], maxConcurrent: 1, holding: [],
      joinedAt: Math.floor(Date.now() / 1000),
    }, new Date());
    socket.failSend = true;
    state.sockets.push(socket);
    const coordinator = new WorkCoordinator(state as unknown as DurableObjectState,
      { DB: db } as unknown as Env);
    await coordinator.fetch(new Request("https://coordinator/notify"));
    const row = sqlite.prepare("SELECT status,attempts FROM work_queue WHERE id = ?")
      .get("send-failure") as { status: string; attempts: number };
    assert.equal(row.status, "claimed");
    assert.equal(row.attempts, 1);
    assert.equal(socket.readyState, 3);
    sqlite.close();
  }

  console.log("work coordinator lease recovery: PASS");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
