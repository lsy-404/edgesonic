// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// Activation core semantics: resolveActivation states, redeemCode
// accumulation model (window consumed first, duration appended after,
// permanent idempotent refusal), invite-code validity checks, expiry
// clamping, registration gate combinations, and code generation format.
//
// Run: npx tsx test/internal/activation_core.test.ts

import { DatabaseSync } from "node:sqlite";
import {
  resolveActivation, redeemCode, checkInviteCode, clampExpiryToActivation,
  clampTtlToActivation, generateInviteCode, evaluateRegistrationGate,
  type ActivationState,
} from "../../worker/src/utils/activation";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// D1 shim (same lazy-prepare recipe as test/subsonic/shares.test.ts, with
// batch running inside a transaction).
function makeD1Shim(): { db: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");

  function prepare(sql: string): D1PreparedStatement {
    let binds: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...args: unknown[]): D1PreparedStatement {
        binds = args;
        return stmt;
      },
      async first<T = unknown>(): Promise<T | null> {
        const s = sqlite.prepare(sql);
        const row = s.get(...(binds as never[]));
        return (row ?? null) as T | null;
      },
      async all<T = unknown>(): Promise<{ results: T[] }> {
        const s = sqlite.prepare(sql);
        const rows = s.all(...(binds as never[]));
        return { results: rows as T[] };
      },
      async run(): Promise<{ meta: { changes: number; last_row_id: number } }> {
        const s = sqlite.prepare(sql);
        const info = s.run(...(binds as never[]));
        return { meta: { changes: Number(info.changes ?? 0), last_row_id: Number(info.lastInsertRowid ?? 0) } };
      },
      async raw<T = unknown>(): Promise<T[]> {
        const s = sqlite.prepare(sql);
        const rows = s.all(...(binds as never[]));
        return rows as T[];
      },
    } as unknown as D1PreparedStatement;
    return stmt;
  }

  const db = {
    prepare,
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<T[]> {
      sqlite.exec("BEGIN");
      try {
        const out: unknown[] = [];
        for (const s of statements) {
          out.push(await (s as unknown as { run(): Promise<unknown> }).run());
        }
        sqlite.exec("COMMIT");
        return out as T[];
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
    async exec(sql: string): Promise<unknown> {
      sqlite.exec(sql);
      return undefined;
    },
  } as unknown as D1Database;

  return { db, sqlite };
}

function setupSchema(sqlite: DatabaseSync): void {
  sqlite.exec(`
    CREATE TABLE users (
      username TEXT PRIMARY KEY,
      master_password TEXT NOT NULL DEFAULT 'x',
      level INTEGER DEFAULT 1,
      enabled INTEGER DEFAULT 1,
      email TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0,
      activation_status TEXT NOT NULL DEFAULT 'permanent',
      activated_until INTEGER,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE features (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0, description TEXT, updated_at INTEGER);
    CREATE TABLE feature_strings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', description TEXT, updated_at INTEGER);
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL, permission TEXT NOT NULL, enabled INTEGER DEFAULT 0, max_rph INTEGER DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    CREATE TABLE invite_codes (
      code TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      window_start INTEGER,
      window_end INTEGER,
      duration_days INTEGER,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE invite_redemptions (
      code TEXT NOT NULL,
      username TEXT NOT NULL,
      redeemed_at INTEGER NOT NULL,
      PRIMARY KEY (code, username)
    );
    INSERT INTO features (key, value) VALUES ('enable_activation', 1);
  `);
}

// A fresh env per scenario defeats the 60s in-isolate feature cache.
function makeEnv(): { env: { DB: D1Database }; sqlite: DatabaseSync } {
  const { db, sqlite } = makeD1Shim();
  setupSchema(sqlite);
  return { env: { DB: db }, sqlite };
}

function seedCode(sqlite: DatabaseSync, row: {
  code: string; kind: string; windowStart?: number | null; windowEnd?: number | null;
  durationDays?: number | null; maxUses?: number; usedCount?: number; revoked?: number;
}): void {
  sqlite.prepare(
    "INSERT INTO invite_codes (code, kind, window_start, window_end, duration_days, max_uses, used_count, note, created_by, created_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'root', 0, ?)"
  ).run(row.code, row.kind, row.windowStart ?? null, row.windowEnd ?? null, row.durationDays ?? null,
    row.maxUses ?? 1, row.usedCount ?? 0, row.revoked ?? 0);
}

function seedUser(sqlite: DatabaseSync, username: string, status: string, until: number | null): void {
  sqlite.prepare("INSERT INTO users (username, activation_status, activated_until) VALUES (?, ?, ?)")
    .run(username, status, until);
}

function getUser(sqlite: DatabaseSync, username: string): { activation_status: string; activated_until: number | null } {
  return sqlite.prepare("SELECT activation_status, activated_until FROM users WHERE username = ?")
    .get(username) as { activation_status: string; activated_until: number | null };
}

async function main() {
  const now = Math.floor(Date.now() / 1000);

  console.log("resolveActivation:");
  {
    const { env, sqlite } = makeEnv();
    sqlite.prepare("UPDATE features SET value = 0 WHERE key = 'enable_activation'").run();
    const off = await resolveActivation(env, { activation_status: "disabled", activated_until: null });
    assert(off.active && off.status === "permanent" && off.until === null && !off.enabled,
      "flag off → active/permanent even for a disabled row");
  }
  {
    const { env } = makeEnv();
    const perm = await resolveActivation(env, { activation_status: "permanent", activated_until: null });
    assert(perm.active && perm.status === "permanent" && perm.until === null, "permanent → active, until=null");

    const future = await resolveActivation(env, { activation_status: "active_until", activated_until: now + 3600 });
    assert(future.active && future.status === "active_until" && future.until === now + 3600, "active_until future → active");

    const past = await resolveActivation(env, { activation_status: "active_until", activated_until: now - 10 });
    assert(!past.active && past.status === "active_until", "active_until past → inactive");

    const noUntil = await resolveActivation(env, { activation_status: "active_until", activated_until: null });
    assert(!noUntil.active, "active_until with NULL until → inactive");

    const disabled = await resolveActivation(env, { activation_status: "disabled", activated_until: null });
    assert(!disabled.active && disabled.status === "disabled", "disabled → inactive");

    const missing = await resolveActivation(env, {});
    assert(missing.active && missing.status === "permanent", "missing fields → treated as permanent");
  }

  console.log("redeemCode: permanent code");
  {
    const { env, sqlite } = makeEnv();
    seedUser(sqlite, "u1", "disabled", null);
    seedCode(sqlite, { code: "INV-PERM", kind: "permanent" });
    const r = await redeemCode(env, "u1", "INV-PERM");
    assert(r.ok && r.status === "permanent" && r.until === null, "disabled + permanent code → permanent");
    const row = getUser(sqlite, "u1");
    assert(row.activation_status === "permanent" && row.activated_until === null, "user row updated");
    const code = sqlite.prepare("SELECT used_count FROM invite_codes WHERE code = 'INV-PERM'").get() as { used_count: number };
    assert(code.used_count === 1, "used_count incremented");
    const red = sqlite.prepare("SELECT COUNT(*) AS c FROM invite_redemptions WHERE code = 'INV-PERM' AND username = 'u1'").get() as { c: number };
    assert(red.c === 1, "redemption recorded");
  }

  console.log("redeemCode: window code");
  {
    const { env, sqlite } = makeEnv();
    seedUser(sqlite, "u1", "disabled", null);
    seedCode(sqlite, { code: "INV-WIN", kind: "window", windowStart: now - 100, windowEnd: now + 5000, maxUses: 5 });
    const r = await redeemCode(env, "u1", "INV-WIN");
    assert(r.ok && r.status === "active_until" && r.until === now + 5000, "window code → active until window_end");

    // Existing expiry beyond window_end: the fixed window is consumed first
    // (max keeps the later expiry, nothing shrinks).
    seedUser(sqlite, "u2", "active_until", now + 9000);
    const r2 = await redeemCode(env, "u2", "INV-WIN");
    assert(r2.ok && r2.until === now + 9000, "window overlapping an even later expiry → expiry unchanged");

    // Existing expiry before window_end extends to window_end.
    seedUser(sqlite, "u3", "active_until", now + 1000);
    const r3 = await redeemCode(env, "u3", "INV-WIN");
    assert(r3.ok && r3.until === now + 5000, "window beyond current expiry → extends to window_end");
  }

  console.log("redeemCode: duration code accumulation");
  {
    const { env, sqlite } = makeEnv();
    seedCode(sqlite, { code: "INV-DUR", kind: "duration", durationDays: 2, maxUses: 5 });

    seedUser(sqlite, "u1", "disabled", null);
    const r1 = await redeemCode(env, "u1", "INV-DUR");
    assert(r1.ok && r1.status === "active_until" && r1.until !== null && Math.abs(r1.until - (now + 2 * 86400)) <= 2,
      "no current expiry → now + days");

    // Duration stacks AFTER the current future expiry (fixed segment first).
    seedUser(sqlite, "u2", "active_until", now + 5000);
    const r2 = await redeemCode(env, "u2", "INV-DUR");
    assert(r2.ok && r2.until === now + 5000 + 2 * 86400, "future expiry → duration appended after it");

    // Expired account: base is now, not the stale past expiry.
    seedUser(sqlite, "u3", "active_until", now - 5000);
    const r3 = await redeemCode(env, "u3", "INV-DUR");
    assert(r3.ok && r3.until !== null && Math.abs(r3.until - (now + 2 * 86400)) <= 2,
      "expired account → duration from now");
  }

  console.log("redeemCode: permanent account idempotent refusal");
  {
    const { env, sqlite } = makeEnv();
    seedUser(sqlite, "u1", "permanent", null);
    seedCode(sqlite, { code: "INV-DUR", kind: "duration", durationDays: 30 });
    seedCode(sqlite, { code: "INV-PERM", kind: "permanent" });
    const r1 = await redeemCode(env, "u1", "INV-DUR");
    assert(!r1.ok, "permanent account + duration code → refused");
    const r2 = await redeemCode(env, "u1", "INV-PERM");
    assert(!r2.ok, "permanent account + permanent code → refused");
    const dur = sqlite.prepare("SELECT used_count FROM invite_codes WHERE code = 'INV-DUR'").get() as { used_count: number };
    assert(dur.used_count === 0, "no use consumed on refusal");
  }

  console.log("redeemCode: invalid code paths");
  {
    const { env, sqlite } = makeEnv();
    seedUser(sqlite, "u1", "disabled", null);
    const missing = await redeemCode(env, "u1", "INV-NOPE");
    assert(!missing.ok, "unknown code refused");

    seedCode(sqlite, { code: "INV-REV", kind: "permanent", revoked: 1 });
    const revoked = await redeemCode(env, "u1", "INV-REV");
    assert(!revoked.ok && !revoked.ok && revoked.error.includes("revoked"), "revoked code refused");

    seedCode(sqlite, { code: "INV-FULL", kind: "permanent", maxUses: 2, usedCount: 2 });
    const full = await redeemCode(env, "u1", "INV-FULL");
    assert(!full.ok, "exhausted code refused");

    seedCode(sqlite, { code: "INV-OLD", kind: "window", windowStart: now - 5000, windowEnd: now - 100 });
    const old = await redeemCode(env, "u1", "INV-OLD");
    assert(!old.ok && old.error.includes("expired"), "past-window code refused");

    const check = await checkInviteCode(env, "INV-OLD");
    assert("error" in check, "checkInviteCode mirrors the same refusal");
  }

  console.log("redeemCode: double redemption is atomic");
  {
    const { env, sqlite } = makeEnv();
    seedUser(sqlite, "u1", "disabled", null);
    seedCode(sqlite, { code: "INV-TWICE", kind: "duration", durationDays: 1, maxUses: 10 });
    const first = await redeemCode(env, "u1", "INV-TWICE");
    assert(first.ok, "first redemption succeeds");
    const before = getUser(sqlite, "u1");
    const second = await redeemCode(env, "u1", "INV-TWICE");
    assert(!second.ok, "second redemption by same account refused");
    const after = getUser(sqlite, "u1");
    assert(after.activated_until === before.activated_until, "user expiry unchanged after refused re-redeem");
    const code = sqlite.prepare("SELECT used_count FROM invite_codes WHERE code = 'INV-TWICE'").get() as { used_count: number };
    assert(code.used_count === 1, "used_count not double-incremented (batch rolled back)");
  }

  console.log("clamping:");
  {
    const active: ActivationState = { enabled: true, active: true, status: "active_until", until: now + 100 };
    assert(clampExpiryToActivation(active, now + 5000) === now + 100, "expiry clamped down to activation");
    assert(clampExpiryToActivation(active, now + 50) === now + 50, "earlier expiry untouched");
    const perm: ActivationState = { enabled: true, active: true, status: "permanent", until: null };
    assert(clampExpiryToActivation(perm, now + 5000) === now + 5000, "permanent not clamped");
    const inactive: ActivationState = { enabled: true, active: false, status: "disabled", until: null };
    assert(clampExpiryToActivation(inactive, now + 5000) === now + 5000, "inactive session TTL not clamped");
    const ttl = clampTtlToActivation(active, 7 * 86400);
    assert(ttl >= 98 && ttl <= 100, `TTL clamped to activation remainder (got ${ttl})`);
    const expired: ActivationState = { enabled: true, active: true, status: "active_until", until: now - 100 };
    assert(clampTtlToActivation(expired, 7 * 86400) === 1, "non-positive remainder floors at 1s");
  }

  console.log("registration gate:");
  {
    assert(evaluateRegistrationGate({ emailConfigured: false, activationEnabled: false, gateMode: "all", hasEmail: false, hasInvite: false }).ok,
      "no options enabled → gate passes (legacy behavior applies)");
    assert(!evaluateRegistrationGate({ emailConfigured: true, activationEnabled: true, gateMode: "all", hasEmail: true, hasInvite: false }).ok,
      "all: email only, invite missing → refused");
    assert(!evaluateRegistrationGate({ emailConfigured: true, activationEnabled: true, gateMode: "all", hasEmail: false, hasInvite: true }).ok,
      "all: invite only, email missing → refused");
    assert(evaluateRegistrationGate({ emailConfigured: true, activationEnabled: true, gateMode: "all", hasEmail: true, hasInvite: true }).ok,
      "all: both satisfied → ok");
    assert(evaluateRegistrationGate({ emailConfigured: true, activationEnabled: true, gateMode: "any", hasEmail: false, hasInvite: true }).ok,
      "any: invite alone → ok");
    assert(evaluateRegistrationGate({ emailConfigured: true, activationEnabled: true, gateMode: "any", hasEmail: true, hasInvite: false }).ok,
      "any: email alone → ok");
    assert(!evaluateRegistrationGate({ emailConfigured: true, activationEnabled: true, gateMode: "any", hasEmail: false, hasInvite: false }).ok,
      "any: neither → refused");
    assert(!evaluateRegistrationGate({ emailConfigured: false, activationEnabled: true, gateMode: "all", hasEmail: false, hasInvite: false }).ok,
      "invite is the only option and missing → refused");
    assert(evaluateRegistrationGate({ emailConfigured: false, activationEnabled: true, gateMode: "all", hasEmail: false, hasInvite: true }).ok,
      "invite is the only option and present → ok");
  }

  console.log("invite code format:");
  {
    for (let i = 0; i < 20; i++) {
      const code = generateInviteCode();
      if (!/^INV-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{12}$/.test(code)) {
        assert(false, `code format (got ${code})`);
        break;
      }
      if (i === 19) assert(true, "20 generated codes all match INV- + 12 unambiguous base32 chars");
    }
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("UNCAUGHT", e);
  process.exit(2);
});
