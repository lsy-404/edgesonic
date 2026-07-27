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

// Account activation: single source of truth for resolving a user's
// activation state, redeeming invite codes, clamping credential lifetimes
// to the activation window, and the registration gate.

import { getFeature, getFeatureString } from "./features";
import { ensureActivationSchema } from "./schema_patch";

export type ActivationStatus = "permanent" | "active_until" | "disabled";

export interface ActivationState {
  enabled: boolean;                 // enable_activation feature flag
  active: boolean;
  status: ActivationStatus;
  until: number | null;             // unix seconds, only for active_until
}

export type ActivationUser = {
  activation_status?: string | null;
  activated_until?: number | null;
};

type ActivationEnv = { DB: D1Database };

function asEnv(env: ActivationEnv): Env {
  return env as unknown as Env;
}

export async function resolveActivation(env: ActivationEnv, user: ActivationUser): Promise<ActivationState> {
  // Fail open (feature off = status quo) when the features table cannot be
  // read at all — matches the flag's compat-preserving default.
  let enabled = false;
  try {
    enabled = await getFeature(asEnv(env), "enable_activation");
  } catch {
    enabled = false;
  }
  if (!enabled) return { enabled: false, active: true, status: "permanent", until: null };

  const status = (user.activation_status === "active_until" || user.activation_status === "disabled")
    ? user.activation_status
    : "permanent";
  if (status === "permanent") return { enabled: true, active: true, status, until: null };
  if (status === "active_until") {
    const until = typeof user.activated_until === "number" ? user.activated_until : null;
    const now = Math.floor(Date.now() / 1000);
    if (until !== null && until > now) return { enabled: true, active: true, status, until };
    return { enabled: true, active: false, status, until };
  }
  return { enabled: true, active: false, status: "disabled", until: null };
}

// Clamp a to-be-issued credential expiry (session, api key) to the caller's
// activation window. Permanent / inactive states are not clamped.
export function clampExpiryToActivation(activation: ActivationState, expiresAt: number): number {
  if (activation.active && activation.status === "active_until" && activation.until !== null) {
    return Math.min(expiresAt, activation.until);
  }
  return expiresAt;
}

export function clampTtlToActivation(activation: ActivationState, ttlSec: number): number {
  const now = Math.floor(Date.now() / 1000);
  const clamped = clampExpiryToActivation(activation, now + ttlSec) - now;
  return Math.max(1, clamped);
}

// The activation horizon a long-lived client credential should carry:
// the end of the current window, or NULL when nothing bounds it.
export function credentialExpiryFor(activation: ActivationState): number | null {
  if (!activation.enabled) return null;
  if (activation.status === "active_until") return activation.until;
  if (activation.status === "disabled") return Math.floor(Date.now() / 1000);
  return null;
}

// Re-stamp every issued credential of a user after their activation changed,
// so extending an account revives its clients and shortening it cuts them off
// without anyone having to re-issue by hand.
export async function restampCredentials(
  env: { DB: D1Database },
  username: string,
  activation: ActivationState,
): Promise<void> {
  await env.DB.prepare("UPDATE subsonic_credentials SET expires_at = ? WHERE username = ?")
    .bind(credentialExpiryFor(activation), username)
    .run();
}

// ============================================================================
// Invite codes
// ============================================================================

// Base32-like alphabet without ambiguous glyphs (0/O, 1/I/L, U/V confusion).
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateInviteCode(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = "INV-";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

export interface InviteCodeRow {
  code: string;
  kind: "window" | "duration" | "permanent";
  window_start: number | null;
  window_end: number | null;
  duration_days: number | null;
  max_uses: number;
  used_count: number;
  note: string | null;
  created_by: string;
  created_at: number;
  revoked: number;
}

export type RedeemResult =
  | { ok: true; status: ActivationStatus; until: number | null }
  | { ok: false; error: string };

// Validity check shared by redeemCode and the registration pre-check.
// Returns the row when redeemable, an error string otherwise.
export async function checkInviteCode(env: ActivationEnv, code: string): Promise<{ row: InviteCodeRow } | { error: string }> {
  await ensureActivationSchema(env);
  const row = await env.DB.prepare("SELECT * FROM invite_codes WHERE code = ?")
    .bind(code).first<InviteCodeRow>();
  if (!row) return { error: "Invalid invite code" };
  if (row.revoked) return { error: "Invite code revoked" };
  if (row.used_count >= row.max_uses) return { error: "Invite code exhausted" };
  if (row.kind === "window") {
    const now = Math.floor(Date.now() / 1000);
    if (row.window_end === null || now > row.window_end) return { error: "Invite code expired" };
  }
  return { row };
}

// Redeem a code for a user. Accumulation model: a single activated_until
// field; window codes extend to max(current, window_end) so an overlapping
// fixed window is consumed first, duration codes append AFTER the current
// expiry (base = max(now, current)). Atomic via D1 batch; the
// invite_redemptions primary key rejects double-redemption of the same code
// by the same account.
export async function redeemCode(env: ActivationEnv, username: string, code: string): Promise<RedeemResult> {
  const checked = await checkInviteCode(env, code.trim());
  if ("error" in checked) return { ok: false, error: checked.error };
  const row = checked.row;

  const user = await env.DB
    .prepare("SELECT activation_status, activated_until FROM users WHERE username = ?")
    .bind(username)
    .first<{ activation_status: string | null; activated_until: number | null }>();
  if (!user) return { ok: false, error: "User not found" };

  if (user.activation_status === "permanent") {
    return { ok: false, error: "Account is already permanently activated" };
  }

  const now = Math.floor(Date.now() / 1000);
  let status: ActivationStatus;
  let until: number | null;
  if (row.kind === "permanent") {
    status = "permanent";
    until = null;
  } else if (row.kind === "window") {
    status = "active_until";
    until = Math.max(user.activated_until ?? 0, row.window_end ?? 0);
  } else {
    const base = Math.max(now, user.activated_until ?? 0);
    status = "active_until";
    until = base + (row.duration_days ?? 0) * 86400;
  }

  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET activation_status = ?, activated_until = ?, updated_at = ? WHERE username = ?")
        .bind(status, until, now, username),
      env.DB.prepare("INSERT INTO invite_redemptions (code, username, redeemed_at) VALUES (?, ?, ?)")
        .bind(row.code, username, now),
      env.DB.prepare("UPDATE invite_codes SET used_count = used_count + 1 WHERE code = ? AND revoked = 0 AND used_count < max_uses")
        .bind(row.code),
    ]);
  } catch (e) {
    if (/UNIQUE|PRIMARY/i.test(e instanceof Error ? e.message : String(e))) {
      return { ok: false, error: "Invite code already redeemed by this account" };
    }
    throw e;
  }
  // Clients issued under the previous horizon follow the account forward.
  await restampCredentials(env, username, { enabled: true, active: true, status, until });
  return { ok: true, status, until };
}

// ============================================================================
// Registration gate
// ============================================================================

export type GateMode = "all" | "any";

export async function getRegistrationGateMode(env: ActivationEnv): Promise<GateMode> {
  const raw = (await getFeatureString(asEnv(env), "registration_gate_mode", "all")).trim();
  return raw === "any" ? "any" : "all";
}

// Enabled signup options: email verification (when email sending is
// configured) and invite code (when the activation system is on). With no
// options enabled the caller falls back to legacy behavior.
export function evaluateRegistrationGate(opts: {
  emailConfigured: boolean;
  activationEnabled: boolean;
  gateMode: GateMode;
  hasEmail: boolean;
  hasInvite: boolean;
}): { ok: boolean; error?: string } {
  const options: Array<{ satisfied: boolean; error: string }> = [];
  if (opts.emailConfigured) options.push({ satisfied: opts.hasEmail, error: "Email verification required" });
  if (opts.activationEnabled) options.push({ satisfied: opts.hasInvite, error: "Invite code required" });
  if (options.length === 0) return { ok: true };
  if (opts.gateMode === "all") {
    const missing = options.find((o) => !o.satisfied);
    return missing ? { ok: false, error: missing.error } : { ok: true };
  }
  return options.some((o) => o.satisfied)
    ? { ok: true }
    : { ok: false, error: "Email verification or invite code required" };
}

// ============================================================================
// Guest fallback probe (freeze semantics)
// ============================================================================

// Whether the shared guest account is usable — same conditions as the
// /edgesonic/auth/guest endpoint: guest row enabled + level-0 browse
// permission. Used to decide what an inactive user degrades to.
export async function isGuestAccessEnabled(
  env: { DB: D1Database; PERMISSIONS_OVERRIDE?: string; DEMO_MODE?: string },
): Promise<boolean> {
  const row = await env.DB
    .prepare("SELECT enabled FROM users WHERE username = 'guest' AND level = 0")
    .first<{ enabled: number }>();
  if (!row || !row.enabled) return false;
  // Local import to avoid a module cycle (permissions.ts imports this file).
  const { hasPermission } = await import("./permissions");
  return hasPermission(env, { level: 0 }, "browse");
}
