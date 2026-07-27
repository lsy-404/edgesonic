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

// Account activation surface: self-service status/redeem (open to inactive
// sessions — authMiddleware allowlists these two paths) and the admin side
// (set status, list/create/revoke invite codes) which requires manage_users
// AND manage_activation.
import { Hono } from "hono";
import { hasPermission } from "../../utils/permissions";
import { isDemoMode } from "../../utils/demoMode";
import { ensureActivationSchema } from "../../utils/schema_patch";
import {
  resolveActivation, redeemCode, generateInviteCode, type InviteCodeRow,
} from "../../utils/activation";
import type { User } from "../../types/entities";

export const activationRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

type Ctx = import("hono").Context<{ Bindings: Env; Variables: { user: User } }>;

async function requireActivationAdmin(c: Ctx): Promise<Response | null> {
  const user = c.get("user");
  if (!(await hasPermission(c.env, user, "manage_users")) || !(await hasPermission(c.env, user, "manage_activation"))) {
    return c.json({ ok: false, error: "Not authorized" }, 403);
  }
  if (isDemoMode(c.env)) {
    return c.json({ ok: false, error: "Activation management is locked in demo mode" }, 403);
  }
  return null;
}

activationRoutes.get("/activation/me", async (c) => {
  const user = c.get("user");
  const activation = await resolveActivation(c.env, user);
  return c.json({
    ok: true,
    enabled: activation.enabled,
    status: activation.status,
    until: activation.until,
    active: activation.active,
  });
});

activationRoutes.post("/activation/redeem", async (c) => {
  const user = c.get("user");
  let body: { code?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const code = (body.code || "").trim();
  if (!code) {
    return c.json({ ok: false, error: "Missing code" }, 400);
  }
  const result = await redeemCode(c.env, user.username, code);
  if (!result.ok) {
    return c.json({ ok: false, error: result.error }, 400);
  }
  return c.json({ ok: true, status: result.status, until: result.until });
});

activationRoutes.post("/activation/set", async (c) => {
  const denied = await requireActivationAdmin(c);
  if (denied) return denied;
  const caller = c.get("user");

  let body: { username?: string; mode?: string; until?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const username = (body.username || "").trim();
  const mode = body.mode;
  if (!username) {
    return c.json({ ok: false, error: "Missing username" }, 400);
  }
  if (mode !== "permanent" && mode !== "until" && mode !== "disabled") {
    return c.json({ ok: false, error: "Invalid mode (permanent|until|disabled)" }, 400);
  }
  if (username === caller.username) {
    return c.json({ ok: false, error: "Cannot change your own activation" }, 400);
  }
  let until: number | null = null;
  if (mode === "until") {
    if (typeof body.until !== "number" || !Number.isInteger(body.until) || body.until <= 0) {
      return c.json({ ok: false, error: "Missing or invalid until timestamp" }, 400);
    }
    until = body.until;
  }

  await ensureActivationSchema(c.env);
  const db = c.env.DB;
  const target = await db.prepare("SELECT username, level FROM users WHERE username = ?")
    .bind(username).first<{ username: string; level: number }>();
  if (!target) {
    return c.json({ ok: false, error: "User not found" }, 404);
  }
  if (target.level >= 3) {
    return c.json({ ok: false, error: "Cannot change an administrator's activation" }, 403);
  }

  const status = mode === "until" ? "active_until" : mode;
  await db.prepare("UPDATE users SET activation_status = ?, activated_until = ?, updated_at = ? WHERE username = ?")
    .bind(status, until, Math.floor(Date.now() / 1000), username).run();
  return c.json({ ok: true });
});

// Shared guard for per-target account actions: caller already passed
// requireActivationAdmin; the target must exist, be non-admin, and not the
// caller themselves.
async function loadManagedTarget(c: Ctx, username: string): Promise<{ error: Response } | { ok: true }> {
  const caller = c.get("user");
  if (!username) {
    return { error: c.json({ ok: false, error: "Missing username" }, 400) };
  }
  if (username === caller.username) {
    return { error: c.json({ ok: false, error: "Cannot target your own account" }, 400) };
  }
  const target = await c.env.DB.prepare("SELECT username, level FROM users WHERE username = ?")
    .bind(username).first<{ username: string; level: number }>();
  if (!target) {
    return { error: c.json({ ok: false, error: "User not found" }, 404) };
  }
  if (target.level >= 3) {
    return { error: c.json({ ok: false, error: "Cannot target an administrator" }, 403) };
  }
  return { ok: true };
}

async function readUsernameBody(c: Ctx): Promise<string | null> {
  try {
    const body = await c.req.json<{ username?: string }>();
    return (body.username || "").trim();
  } catch {
    return null;
  }
}

// Kill every web session of the target; their next request re-authenticates.
activationRoutes.post("/activation/revokeSessions", async (c) => {
  const denied = await requireActivationAdmin(c);
  if (denied) return denied;
  const username = await readUsernameBody(c);
  if (username === null) return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  const guard = await loadManagedTarget(c, username);
  if ("error" in guard) return guard.error;
  const result = await c.env.DB.prepare("DELETE FROM sessions WHERE username = ?").bind(username).run();
  return c.json({ ok: true, revoked: result.meta.changes ?? 0 });
});

// Kill every issued client credential (Subsonic passwords + raw api keys);
// native clients drop off at their next auth.
activationRoutes.post("/activation/revokeCredentials", async (c) => {
  const denied = await requireActivationAdmin(c);
  if (denied) return denied;
  const username = await readUsernameBody(c);
  if (username === null) return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  const guard = await loadManagedTarget(c, username);
  if ("error" in guard) return guard.error;
  const [creds, keys] = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM subsonic_credentials WHERE username = ?").bind(username),
    c.env.DB.prepare("DELETE FROM api_keys WHERE username = ?").bind(username),
  ]);
  return c.json({ ok: true, revoked: (creds.meta.changes ?? 0) + (keys.meta.changes ?? 0) });
});

activationRoutes.get("/activation/codes", async (c) => {
  const denied = await requireActivationAdmin(c);
  if (denied) return denied;
  await ensureActivationSchema(c.env);
  const rows = await c.env.DB
    .prepare("SELECT * FROM invite_codes ORDER BY created_at DESC")
    .all<InviteCodeRow>();
  return c.json({
    ok: true,
    codes: (rows.results ?? []).map((r) => ({
      code: r.code,
      kind: r.kind,
      windowStart: r.window_start,
      windowEnd: r.window_end,
      durationDays: r.duration_days,
      maxUses: r.max_uses,
      usedCount: r.used_count,
      note: r.note,
      revoked: !!r.revoked,
      createdBy: r.created_by,
      createdAt: r.created_at,
    })),
  });
});

activationRoutes.post("/activation/codes", async (c) => {
  const denied = await requireActivationAdmin(c);
  if (denied) return denied;
  const caller = c.get("user");

  let body: { kind?: string; windowStart?: number; windowEnd?: number; durationDays?: number; maxUses?: number; note?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const kind = body.kind;
  if (kind !== "window" && kind !== "duration" && kind !== "permanent") {
    return c.json({ ok: false, error: "Invalid kind (window|duration|permanent)" }, 400);
  }
  let windowStart: number | null = null;
  let windowEnd: number | null = null;
  let durationDays: number | null = null;
  if (kind === "window") {
    if (typeof body.windowStart !== "number" || !Number.isInteger(body.windowStart) || body.windowStart < 0
      || typeof body.windowEnd !== "number" || !Number.isInteger(body.windowEnd) || body.windowEnd <= body.windowStart) {
      return c.json({ ok: false, error: "Invalid window (need windowStart < windowEnd)" }, 400);
    }
    windowStart = body.windowStart;
    windowEnd = body.windowEnd;
  }
  if (kind === "duration") {
    if (typeof body.durationDays !== "number" || !Number.isInteger(body.durationDays) || body.durationDays < 1 || body.durationDays > 36500) {
      return c.json({ ok: false, error: "Invalid durationDays (1-36500)" }, 400);
    }
    durationDays = body.durationDays;
  }
  const maxUses = body.maxUses === undefined ? 1 : body.maxUses;
  if (typeof maxUses !== "number" || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000000) {
    return c.json({ ok: false, error: "Invalid maxUses (1-1000000)" }, 400);
  }
  const note = typeof body.note === "string" ? body.note.trim() : null;
  if (note !== null && note.length > 200) {
    return c.json({ ok: false, error: "Note too long (max 200 chars)" }, 400);
  }

  await ensureActivationSchema(c.env);
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);
  // Retry on the astronomically-unlikely code collision.
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateInviteCode();
    try {
      await db.prepare(
        "INSERT INTO invite_codes (code, kind, window_start, window_end, duration_days, max_uses, used_count, note, created_by, created_at, revoked) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0)"
      ).bind(code, kind, windowStart, windowEnd, durationDays, maxUses, note || null, caller.username, now).run();
      return c.json({ ok: true, code });
    } catch (e) {
      if (!/UNIQUE|PRIMARY/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
  }
  return c.json({ ok: false, error: "Failed to generate a unique code" }, 500);
});

activationRoutes.post("/activation/codes/revoke", async (c) => {
  const denied = await requireActivationAdmin(c);
  if (denied) return denied;
  let body: { code?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const code = (body.code || "").trim();
  if (!code) {
    return c.json({ ok: false, error: "Missing code" }, 400);
  }
  await ensureActivationSchema(c.env);
  const result = await c.env.DB.prepare("UPDATE invite_codes SET revoked = 1 WHERE code = ?")
    .bind(code).run();
  if (!result.meta.changes) {
    return c.json({ ok: false, error: "Invite code not found" }, 404);
  }
  return c.json({ ok: true });
});
