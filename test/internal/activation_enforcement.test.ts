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

// Activation enforcement end to end: permission freeze for inactive
// accounts, authMiddleware behavior (Subsonic credential refusal, inactive
// session allowlist, guest degradation), login TTL clamping, the
// /edgesonic/activation/* endpoints with their permission matrix, and the
// invite-gated registration endpoint in both gate modes.
//
// Run: npx tsx test/internal/activation_enforcement.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { authMiddleware, sha256 } from "../../worker/src/auth";
import { webLoginRoutes } from "../../worker/src/endpoints/edgesonic/auth";
import { activationRoutes } from "../../worker/src/endpoints/edgesonic/activation";
import { hasPermission, getEffectivePermissions } from "../../worker/src/utils/permissions";
import { md5 } from "../../worker/src/utils/md5";
import type { User } from "../../worker/src/types/entities";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

function makeD1Shim(): { db: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");

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

function setupSchema(sqlite: DatabaseSync, opts: { guestEnabled: boolean }): void {
  sqlite.exec(`
    CREATE TABLE users (
      username TEXT PRIMARY KEY,
      master_password TEXT NOT NULL DEFAULT 'x',
      level INTEGER DEFAULT 1,
      enabled INTEGER DEFAULT 1,
      avatar_r2_key TEXT,
      nickname TEXT,
      email TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0,
      activation_status TEXT NOT NULL DEFAULT 'permanent',
      activated_until INTEGER,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    CREATE UNIQUE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
      user_agent TEXT, expires_at INTEGER NOT NULL, created_at INTEGER DEFAULT 0
    );
    CREATE TABLE subsonic_credentials (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, password TEXT NOT NULL,
      label TEXT DEFAULT '', stream_proxy_strategy TEXT NOT NULL DEFAULT 'always',
      last_used INTEGER, created_at INTEGER DEFAULT 0, expires_at INTEGER
    );
    CREATE TABLE api_keys (api_key TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER DEFAULT 0);
    CREATE TABLE guest_tokens (token TEXT PRIMARY KEY, created_by TEXT, expires_at INTEGER, created_at INTEGER DEFAULT 0);
    CREATE TABLE features (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0, description TEXT, updated_at INTEGER);
    CREATE TABLE feature_strings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', description TEXT, updated_at INTEGER);
    CREATE TABLE external_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at INTEGER);
    CREATE TABLE email_tokens (
      token TEXT PRIMARY KEY, username TEXT NOT NULL, purpose TEXT NOT NULL,
      new_email TEXT, expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER DEFAULT 0
    );
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL, permission TEXT NOT NULL, enabled INTEGER DEFAULT 0, max_rph INTEGER DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    CREATE TABLE invite_codes (
      code TEXT PRIMARY KEY, kind TEXT NOT NULL, window_start INTEGER, window_end INTEGER,
      duration_days INTEGER, max_uses INTEGER NOT NULL DEFAULT 1, used_count INTEGER NOT NULL DEFAULT 0,
      note TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE invite_redemptions (
      code TEXT NOT NULL, username TEXT NOT NULL, redeemed_at INTEGER NOT NULL,
      PRIMARY KEY (code, username)
    );
    INSERT INTO features (key, value) VALUES
      ('enable_activation', 1), ('open_registration', 0), ('allow_email_password_reset', 0);
    INSERT INTO feature_strings (key, value) VALUES
      ('registration_gate_mode', 'all'),
      ('resend_from_email', ''), ('resend_from_name', 'EdgeSonic'),
      ('email_tpl_verify_subject', 'Verify'), ('email_tpl_verify_body', 'Click {{link}}');
    INSERT INTO user_permissions (level, permission, enabled) VALUES
      (2, 'manage_users', 1), (2, 'manage_activation', 0),
      (1, 'stream', 1), (1, 'download', 1), (1, 'browse', 1), (1, 'search', 1),
      (0, 'stream', 1), (0, 'browse', 1), (0, 'search', 0);
  `);
  if (opts.guestEnabled) {
    sqlite.prepare("INSERT INTO users (username, level, enabled) VALUES ('guest', 0, 1)").run();
  }
}

type Harness = {
  sqlite: DatabaseSync;
  env: { DB: D1Database; INSTANCE_ID: string };
  request: (path: string, init?: RequestInit) => Promise<Response>;
};

function makeHarness(opts: { guestEnabled: boolean }): Harness {
  const { db, sqlite } = makeD1Shim();
  setupSchema(sqlite, opts);
  const env = { DB: db, INSTANCE_ID: "test" };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any }>();
  app.route("/", webLoginRoutes);
  app.use("/rest/*", authMiddleware);
  app.use("/edgesonic/*", authMiddleware);
  app.route("/edgesonic", activationRoutes);
  // Stand-ins for protected surfaces.
  app.get("/rest/ping", (c) => c.text("<ok/>"));
  app.get("/rest/getPlaylists", (c) => c.text("<ok/>"));
  app.get("/rest/scrobble", (c) => c.text("<ok/>"));
  app.get("/edgesonic/mgmtread", (c) => c.json({ ok: true }));
  app.post("/edgesonic/mgmtwrite", (c) => c.json({ ok: true }));

  return {
    sqlite,
    env,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: (path, init) => app.fetch(new Request(`http://test${path}`, init), env as any),
  };
}

async function seedUser(h: Harness, username: string, level: number, status: string, until: number | null): Promise<void> {
  h.sqlite.prepare(
    "INSERT INTO users (username, master_password, level, activation_status, activated_until) VALUES (?, ?, ?, ?, ?)"
  ).run(username, await sha256("pw"), level, status, until);
  h.sqlite.prepare(
    "INSERT INTO sessions (id, username, token, expires_at) VALUES (?, ?, ?, ?)"
  ).run(`sid-${username}`, username, `tok-${username}`, Math.floor(Date.now() / 1000) + 7 * 86400);
}

function cookieFor(username: string): Record<string, string> {
  return { Cookie: `edgesonic_session=tok-${username}` };
}

async function postJson(h: Harness, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return h.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function main() {
  const now = Math.floor(Date.now() / 1000);

  // ==========================================================================
  console.log("permission freeze (hasPermission / getEffectivePermissions):");
  {
    const h = makeHarness({ guestEnabled: true });
    const inactive = { level: 1, activation_status: "disabled", activated_until: null };
    assert(await hasPermission(h.env, inactive, "stream") === true, "inactive + guest on: stream degrades to guest grant");
    assert(await hasPermission(h.env, inactive, "search") === false, "inactive + guest on: search follows the guest row (off)");
    assert(await hasPermission(h.env, inactive, "download") === false, "inactive: download denied (not guest-grade)");
    assert(await hasPermission(h.env, inactive, "manage_users") === false, "inactive: management denied");

    const active = { level: 1, activation_status: "active_until", activated_until: now + 3600 };
    assert(await hasPermission(h.env, active, "download") === true, "active_until in the future keeps own permissions");
    assert(await hasPermission(h.env, { level: 1 }, "download") === true, "bare {level} probe unaffected");

    // Missing rows surface as undefined (falsy), matching the pre-existing
    // "no row = disabled" semantics of the permission map.
    const effective = await getEffectivePermissions(h.env, { username: "x", ...inactive } as unknown as User);
    assert(effective.stream === true && !effective.download && !effective.manage_users,
      "effective map mirrors the guest degradation");
  }
  {
    const h = makeHarness({ guestEnabled: false });
    const inactive = { level: 1, activation_status: "active_until", activated_until: now - 10 };
    assert(await hasPermission(h.env, inactive, "stream") === false, "inactive + guest off: even stream denied");
    const effective = await getEffectivePermissions(h.env, { username: "x", ...inactive } as unknown as User);
    assert(Object.values(effective).every((v) => v === false), "inactive + guest off: all-false effective map");
  }

  // ==========================================================================
  console.log("authMiddleware: Subsonic credentials of an inactive account:");
  {
    const h = makeHarness({ guestEnabled: true });
    await seedUser(h, "carol", 1, "disabled", null);
    await seedUser(h, "carl", 1, "permanent", null);
    h.sqlite.prepare("INSERT INTO subsonic_credentials (id, username, password) VALUES ('c1', 'carol', 'secret')").run();
    h.sqlite.prepare("INSERT INTO subsonic_credentials (id, username, password) VALUES ('c2', 'carl', 'secret')").run();
    const salt = "abc123";
    const t = md5("secret" + salt);

    const denied = await h.request(`/rest/ping?u=carol&t=${t}&s=${salt}`);
    const deniedBody = await denied.text();
    assert(denied.status === 401 && deniedBody.includes('code="40"') && deniedBody.includes("Account not activated"),
      "inactive account via token+salt → subsonicError 40");

    const okResp = await h.request(`/rest/ping?u=carl&t=${t}&s=${salt}`);
    assert(okResp.status === 200, "active account via token+salt → 200");

    h.sqlite.prepare("INSERT INTO api_keys (api_key, username) VALUES ('key-carol', 'carol')").run();
    const apiDenied = await h.request(`/rest/ping?apiKey=key-carol`);
    assert(apiDenied.status === 401 && (await apiDenied.text()).includes('code="40"'),
      "inactive account via apiKey → subsonicError 40");
  }

  // ==========================================================================
  console.log("authMiddleware: inactive web session, guest disabled:");
  {
    const h = makeHarness({ guestEnabled: false });
    await seedUser(h, "erin", 1, "disabled", null);
    const c = cookieFor("erin");

    const me = await h.request("/edgesonic/activation/me", { headers: c });
    const meBody = await me.json() as { ok: boolean; active: boolean; enabled: boolean; status: string };
    assert(me.status === 200 && meBody.ok && !meBody.active && meBody.enabled && meBody.status === "disabled",
      "/activation/me reachable and reports inactive");

    const read = await h.request("/edgesonic/mgmtread", { headers: c });
    assert(read.status === 403, "management GET denied");
    const rest = await h.request("/rest/getPlaylists", { headers: c });
    assert(rest.status === 403, "REST read denied");

    // The guest-availability probe must stay reachable — the SPA uses it to
    // decide between guest degradation and the activation-required page.
    const probe = await h.request("/edgesonic/auth/guest", { headers: c });
    const probeBody = await probe.json() as { ok: boolean; enabled: boolean };
    assert(probe.status === 200 && probeBody.ok && probeBody.enabled === false,
      "guest probe reachable for inactive session (reports disabled)");
  }

  // ==========================================================================
  console.log("authMiddleware: inactive web session, guest enabled (read-only degradation):");
  {
    const h = makeHarness({ guestEnabled: true });
    await seedUser(h, "dave", 1, "active_until", now - 100);
    const c = cookieFor("dave");

    assert((await h.request("/rest/ping", { headers: c })).status === 200, "REST ping allowed");
    assert((await h.request("/rest/getPlaylists", { headers: c })).status === 200, "own-data REST GET allowed");
    assert((await h.request("/rest/scrobble", { headers: c })).status === 403, "non-read REST endpoint denied");
    assert((await h.request("/edgesonic/mgmtread", { headers: c })).status === 200, "management GET allowed");
    assert((await postJson(h, "/edgesonic/mgmtwrite", {}, c)).status === 403, "management POST denied");
  }

  // ==========================================================================
  console.log("redeem flow thaws a frozen session:");
  {
    const h = makeHarness({ guestEnabled: false });
    await seedUser(h, "alice", 1, "disabled", null);
    h.sqlite.prepare(
      "INSERT INTO invite_codes (code, kind, created_by, created_at) VALUES ('INV-EPERM', 'permanent', 'root', 0)"
    ).run();
    const c = cookieFor("alice");

    assert((await postJson(h, "/edgesonic/mgmtwrite", {}, c)).status === 403, "frozen before redeem");
    const redeemed = await postJson(h, "/edgesonic/activation/redeem", { code: "INV-EPERM" }, c);
    const redeemedBody = await redeemed.json() as { ok: boolean; status: string; until: number | null };
    assert(redeemed.status === 200 && redeemedBody.ok && redeemedBody.status === "permanent" && redeemedBody.until === null,
      "redeem endpoint reachable while inactive and succeeds");
    assert((await postJson(h, "/edgesonic/mgmtwrite", {}, c)).status === 200, "unfrozen after redeem");
    const again = await postJson(h, "/edgesonic/activation/redeem", { code: "INV-EPERM" }, c);
    assert(again.status === 400, "second redeem refused (already permanent)");
  }

  // ==========================================================================
  console.log("login: session TTL clamped to activation window:");
  {
    const h = makeHarness({ guestEnabled: true });
    await seedUser(h, "fran", 1, "active_until", now + 1000);
    const resp = await postJson(h, "/edgesonic/auth/login", { username: "fran", password: "pw" });
    const body = await resp.json() as { ok: boolean; expiresAt: number; activation: { active: boolean; status: string; until: number } };
    assert(resp.status === 200 && body.ok, "login succeeds");
    assert(body.expiresAt <= now + 1000 + 5 && body.expiresAt >= now + 990, `expiresAt clamped to activation (got ${body.expiresAt - now}s)`);
    assert(body.activation && body.activation.active && body.activation.status === "active_until",
      "login response carries activation info");
    const cookie = resp.headers.get("Set-Cookie") || "";
    const maxAge = parseInt((cookie.match(/Max-Age=(\d+)/) || [])[1] || "0", 10);
    assert(maxAge > 0 && maxAge <= 1000, `cookie Max-Age clamped (got ${maxAge})`);

    await seedUser(h, "gene", 1, "disabled", null);
    const inResp = await postJson(h, "/edgesonic/auth/login", { username: "gene", password: "pw" });
    const inBody = await inResp.json() as { ok: boolean; activation: { active: boolean } };
    assert(inResp.status === 200 && inBody.ok && inBody.activation.active === false,
      "inactive user still gets a (restricted) session with activation info");
  }

  // ==========================================================================
  console.log("admin endpoints: permission matrix for /activation/set:");
  {
    const h = makeHarness({ guestEnabled: true });
    await seedUser(h, "root", 3, "permanent", null);
    await seedUser(h, "adm", 2, "permanent", null);
    await seedUser(h, "alice", 1, "permanent", null);

    const denied = await postJson(h, "/edgesonic/activation/set",
      { username: "alice", mode: "disabled" }, cookieFor("adm"));
    assert(denied.status === 403, "manage_users without manage_activation → 403");

    h.sqlite.prepare("UPDATE user_permissions SET enabled = 1 WHERE level = 2 AND permission = 'manage_activation'").run();
    const ok = await postJson(h, "/edgesonic/activation/set",
      { username: "alice", mode: "until", until: now + 5000 }, cookieFor("adm"));
    assert(ok.status === 200, "manage_users + manage_activation → allowed");
    const row = h.sqlite.prepare("SELECT activation_status, activated_until FROM users WHERE username = 'alice'").get() as { activation_status: string; activated_until: number };
    assert(row.activation_status === "active_until" && row.activated_until === now + 5000, "target row updated");

    const admin = await postJson(h, "/edgesonic/activation/set",
      { username: "root", mode: "disabled" }, cookieFor("adm"));
    assert(admin.status === 403, "administrator target refused");
    const self = await postJson(h, "/edgesonic/activation/set",
      { username: "adm", mode: "disabled" }, cookieFor("adm"));
    assert(self.status === 400, "self target refused");
    const badMode = await postJson(h, "/edgesonic/activation/set",
      { username: "alice", mode: "forever" }, cookieFor("adm"));
    assert(badMode.status === 400, "unknown mode refused");
    const noUntil = await postJson(h, "/edgesonic/activation/set",
      { username: "alice", mode: "until" }, cookieFor("adm"));
    assert(noUntil.status === 400, "mode=until without timestamp refused");

    const user = await postJson(h, "/edgesonic/activation/set",
      { username: "adm", mode: "disabled" }, cookieFor("alice"));
    assert(user.status === 403, "regular user → 403");
  }

  // ==========================================================================
  console.log("admin endpoints: invite code lifecycle:");
  {
    const h = makeHarness({ guestEnabled: true });
    await seedUser(h, "root", 3, "permanent", null);
    const c = cookieFor("root");

    const badWindow = await postJson(h, "/edgesonic/activation/codes",
      { kind: "window", windowStart: now + 100, windowEnd: now + 50 }, c);
    assert(badWindow.status === 400, "window with end <= start refused");
    const badKind = await postJson(h, "/edgesonic/activation/codes", { kind: "eternal" }, c);
    assert(badKind.status === 400, "unknown kind refused");

    const created = await postJson(h, "/edgesonic/activation/codes",
      { kind: "duration", durationDays: 30, maxUses: 3, note: "batch one" }, c);
    const createdBody = await created.json() as { ok: boolean; code: string };
    assert(created.status === 200 && createdBody.ok && /^INV-/.test(createdBody.code), "duration code created");

    const list = await h.request("/edgesonic/activation/codes", { headers: c });
    const listBody = await list.json() as { ok: boolean; codes: Array<{ code: string; kind: string; durationDays: number; maxUses: number; usedCount: number; note: string; revoked: boolean; createdBy: string }> };
    const entry = listBody.codes.find((x) => x.code === createdBody.code);
    assert(!!entry && entry.kind === "duration" && entry.durationDays === 30 && entry.maxUses === 3
      && entry.usedCount === 0 && entry.note === "batch one" && entry.revoked === false && entry.createdBy === "root",
      "code list shape matches the contract");

    const revoked = await postJson(h, "/edgesonic/activation/codes/revoke", { code: createdBody.code }, c);
    assert(revoked.status === 200, "revoke succeeds");
    const missing = await postJson(h, "/edgesonic/activation/codes/revoke", { code: "INV-ZZZZZZZZZZZZ" }, c);
    assert(missing.status === 404, "revoking an unknown code → 404");

    await seedUser(h, "alice", 1, "disabled", null);
    const useRevoked = await postJson(h, "/edgesonic/activation/redeem", { code: createdBody.code }, cookieFor("alice"));
    assert(useRevoked.status === 400, "redeeming a revoked code refused");
  }

  // ==========================================================================
  console.log("registration: invite gate (activation on, email not configured):");
  {
    const h = makeHarness({ guestEnabled: true });
    h.sqlite.prepare("UPDATE features SET value = 1 WHERE key = 'open_registration'").run();
    h.sqlite.prepare(
      "INSERT INTO invite_codes (code, kind, duration_days, max_uses, created_by, created_at) VALUES ('INV-REG', 'duration', 7, 5, 'root', 0)"
    ).run();

    const noCode = await postJson(h, "/edgesonic/auth/register",
      { username: "newuser", password: "longpassword" }, {});
    assert(noCode.status === 400, "gate all: registration without invite refused");

    const badCode = await postJson(h, "/edgesonic/auth/register",
      { username: "newuser", password: "longpassword", inviteCode: "INV-WRONG" }, {});
    assert(badCode.status === 400, "invalid invite code refused");

    const withCode = await postJson(h, "/edgesonic/auth/register",
      { username: "newuser", password: "longpassword", inviteCode: "INV-REG" }, {});
    assert(withCode.status === 200, "registration with valid invite succeeds (no email needed)");
    const row = h.sqlite.prepare("SELECT activation_status, activated_until, email FROM users WHERE username = 'newuser'").get() as { activation_status: string; activated_until: number; email: string | null };
    assert(row.activation_status === "active_until" && row.activated_until >= now + 7 * 86400 - 5 && row.email === null,
      "new account activated by the code, email stays NULL");
  }

  // ==========================================================================
  console.log("registration: gate any + no-code path lands disabled:");
  {
    const h = makeHarness({ guestEnabled: true });
    h.sqlite.prepare("UPDATE features SET value = 1 WHERE key = 'open_registration'").run();
    h.sqlite.prepare("UPDATE feature_strings SET value = 'any' WHERE key = 'registration_gate_mode'").run();
    h.sqlite.prepare("INSERT INTO external_secrets (key, value) VALUES ('resend_api_key', 'test_key')").run();
    h.sqlite.prepare("UPDATE feature_strings SET value = 'noreply@test.com' WHERE key = 'resend_from_email'").run();

    const neither = await postJson(h, "/edgesonic/auth/register",
      { username: "nobody", password: "longpassword" }, {});
    assert(neither.status === 400, "gate any: neither email nor invite → refused");

    const emailOnly = await postJson(h, "/edgesonic/auth/register",
      { username: "mailonly", password: "longpassword", email: "mail@test.com" }, {});
    assert(emailOnly.status === 200, "gate any: email alone passes");
    const row = h.sqlite.prepare("SELECT activation_status FROM users WHERE username = 'mailonly'").get() as { activation_status: string };
    assert(row.activation_status === "disabled", "activation on + no code → account starts disabled");

    h.sqlite.prepare(
      "INSERT INTO invite_codes (code, kind, created_by, created_at) VALUES ('INV-ANY', 'permanent', 'root', 0)"
    ).run();
    const inviteOnly = await postJson(h, "/edgesonic/auth/register",
      { username: "codeonly", password: "longpassword", inviteCode: "INV-ANY" }, {});
    assert(inviteOnly.status === 200, "gate any: invite alone passes");
    const row2 = h.sqlite.prepare("SELECT activation_status FROM users WHERE username = 'codeonly'").get() as { activation_status: string };
    assert(row2.activation_status === "permanent", "permanent code applied at registration");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("UNCAUGHT", e);
  process.exit(2);
});
