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

// credentials, guest tokens. Login is the only route in this whole tree that
// runs *before* the global authMiddleware (it issues the session token used by
// every other endpoint in /tag /storage /edgesonic).
import { Hono } from "hono";
import { permissionMiddleware, subsonicError, hashWebPassword, verifyWebPassword, SESSION_TTL_SEC, buildSessionCookieHeader, GUEST_USERNAME } from "../../auth";
import { subsonicOK } from "../../utils/xml";
import { recoverCronIfStale } from "../../utils/cronRecovery";
import { getEffectivePermissions, hasPermission } from "../../utils/permissions";
import { ensureNicknameColumn, ensureEmailColumns, ensureActivationSchema, ensureSubsonicMasterPasswordNoticeColumn } from "../../utils/schema_patch";
import { getFeature, getFeatureString } from "../../utils/features";
import {
  resolveActivation, clampTtlToActivation, checkInviteCode, redeemCode,
  evaluateRegistrationGate, getRegistrationGateMode, credentialExpiryFor,
} from "../../utils/activation";
import { isDemoMode } from "../../utils/demoMode";
import {
  emailSendingConfigured, sendEmail, createEmailToken, consumeEmailToken, consumeEmailChangeToken,
  verifyEmailTemplate, resetPasswordEmailTemplate, changeEmailTemplate, normalizeEmail,
} from "../../utils/email";
import type { User } from "../../types/entities";
import { clearLoginFailures, loginAllowed, recordLoginFailure, verifyTurnstile } from "../../utils/loginProtection";

// only request that legitimately arrives without a session) and is exported
// separately so index.ts can mount it BEFORE the global auth filter at the
// /edgesonic/auth/login + /edgesonic/auth/logout paths.
export const webLoginRoutes = new Hono<{ Bindings: Env }>();

const SESSION_COOKIE = "edgesonic_session";
// SESSION_TTL_SEC (7 days) is imported from ../../auth so the cookie Max-Age
// matches the server-side session lifetime and the sliding renewal in
// authMiddleware. Previously this file declared its own 86400 (1 day), so the
// cookie expired a day after login while the DB session lived for 7 — a
// post-deploy reload then hit 401 and the SPA logged out.
// sessionCookieHeader is likewise shared via buildSessionCookieHeader to keep
// attributes (Path=/, HttpOnly, SameSite=Lax) identical across login, logout
// and the middleware's sliding renewal.

webLoginRoutes.post("/edgesonic/auth/login", async (c) => {
  const db = c.env.DB;

  let body: { username?: string; password?: string; turnstileToken?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const { username, password } = body;
  if (!username || !password) {
    return c.json({ ok: false, error: "Missing username or password" }, 400);
  }
  const retryAfter = await loginAllowed(db, c.req.raw, username);
  if (retryAfter > 0) {
    c.header("Retry-After", String(retryAfter));
    return c.json({ ok: false, error: "Too many login attempts" }, 429);
  }
  if (!(await verifyTurnstile(c.env, c.req.raw, body.turnstileToken, "login"))) {
    return c.json({ ok: false, error: "Verification failed" }, 403);
  }

  // SELECT * so activation columns come along when present (undefined on a
  // not-yet-migrated database → treated as permanent).
  const user = await db
    .prepare("SELECT * FROM users WHERE username = ?")
    .bind(username)
    .first<{ username: string; master_password: string; level: number; enabled: number; activation_status?: string | null; activated_until?: number | null }>();
  if (!user || !user.enabled) {
    await recordLoginFailure(db, c.req.raw, username);
    return c.json({ ok: false, error: "Invalid credentials" }, 401);
  }
  if (user.level === 0 && user.username !== GUEST_USERNAME) {
    return c.json({ ok: false, error: "Invalid credentials" }, 401);
  }

  const verifiedPassword = await verifyWebPassword(password, user.master_password);
  if (!verifiedPassword.valid) {
    await recordLoginFailure(db, c.req.raw, username);
    return c.json({ ok: false, error: "Invalid credentials" }, 401);
  }
  if (verifiedPassword.legacy) {
    await db.prepare("UPDATE users SET master_password = ? WHERE username = ?")
      .bind(await hashWebPassword(password), username).run();
  }
  await clearLoginFailures(db, c.req.raw, username);

  // Session TTL is clamped to the activation window; an inactive user still
  // gets a (restricted) session so they can redeem an invite code.
  const activation = await resolveActivation(c.env, user);
  const ttlSec = clampTtlToActivation(activation, SESSION_TTL_SEC);

  const sessionId = crypto.randomUUID();
  const sessionToken = crypto.randomUUID().replace(/-/g, "");
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSec;
  const userAgent = c.req.header("User-Agent") || "";

  await db
    .prepare(
      "INSERT INTO sessions (id, username, token, user_agent, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(sessionId, username, sessionToken, userAgent, expiresAt, Math.floor(Date.now() / 1000))
    .run();

  // Post-deploy cron auto-recovery. A `wrangler deploy` clears the Worker's
  // cron triggers; this restores them from the recorded state when the running
  // WORKER_VERSION differs from the build cron was last applied under. A super
  // admin (level 3) login is the trigger point. Gated on level 3 — NOT the
  // delegatable manage_cloudflare permission — because it touches the CF API
  // token, which only the super admin may. Runs detached so it never delays
  // the login response.
  if (user.level >= 3) {
    const recovery = recoverCronIfStale(c.env).catch(() => {});
    try {
      c.executionCtx.waitUntil(recovery);
    } catch {
      // No execution context (e.g. unit tests) — let it run detached.
      void recovery;
    }
  }

  // Plant an HttpOnly cookie alongside the JSON response so the SPA can
  // stop persisting the session token in localStorage; the browser now
  // carries it for every same-origin request (fetch, <audio>, <img>,
  // XHR). The JSON sessionToken is still returned for backwards
  // compatibility (clients that use it as a Subsonic plain password via
  // /rest/?u=&p=), but the SPA itself no longer reads it.
  const isHttps = new URL(c.req.url).protocol === "https:";
  const cookie = buildSessionCookieHeader(sessionToken, ttlSec) + (isHttps ? "; Secure" : "");
  c.header("Set-Cookie", cookie);
  return c.json(
    {
      ok: true,
      username,
      level: user.level,
      sessionToken,
      expiresAt,
      activation: {
        enabled: activation.enabled,
        status: activation.status,
        until: activation.until,
        active: activation.active,
      },
    },
    200,
  );
});

webLoginRoutes.get("/edgesonic/auth/guest", async (c) => {
  const user = await c.env.DB
    .prepare("SELECT username, level, enabled FROM users WHERE username = ? AND level = 0 AND enabled = 1")
    .bind(GUEST_USERNAME)
    .first<{ username: string; level: number; enabled: number }>();
  return c.json({ ok: true, enabled: !!user && await hasPermission(c.env, user, "browse") });
});

webLoginRoutes.post("/edgesonic/auth/guest", async (c) => {
  const db = c.env.DB;
  const user = await db
    .prepare("SELECT username, level, enabled FROM users WHERE username = ? AND level = 0 AND enabled = 1")
    .bind(GUEST_USERNAME)
    .first<{ username: string; level: number; enabled: number }>();
  if (!user || !(await hasPermission(c.env, user, "browse"))) {
    return c.json({ ok: false, error: "Guest access is disabled" }, 403);
  }

  const sessionId = crypto.randomUUID();
  const sessionToken = crypto.randomUUID().replace(/-/g, "");
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  await db
    .prepare(
      "INSERT INTO sessions (id, username, token, user_agent, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(sessionId, user.username, sessionToken, c.req.header("User-Agent") || "", expiresAt, Math.floor(Date.now() / 1000))
    .run();

  const isHttps = new URL(c.req.url).protocol === "https:";
  c.header("Set-Cookie", buildSessionCookieHeader(sessionToken, SESSION_TTL_SEC) + (isHttps ? "; Secure" : ""));
  return c.json({ ok: true, username: user.username, level: user.level, expiresAt });
});

webLoginRoutes.post("/edgesonic/auth/logout", async (c) => {
  const db = c.env.DB;

  let body: { sessionToken?: string; username?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }

  if (body.sessionToken) {
    await db.prepare("DELETE FROM sessions WHERE token = ?").bind(body.sessionToken).run();
  } else {
    // Cookie-only SPA sessions have no token in the request body; invalidate
    // whatever the cookie carries so a stolen browser session can't keep
    // serving after the user clicked "Sign out".
    const cookieToken = parseSessionCookie(c.req.header("Cookie") || "");
    if (cookieToken) {
      await db.prepare("DELETE FROM sessions WHERE token = ?").bind(cookieToken).run();
    }
  }

  // Always wipe the browser cookie too — covers both cookie-only and
  // signedParams-style SPA sessions.
  const isHttps = new URL(c.req.url).protocol === "https:";
  c.header("Set-Cookie", buildSessionCookieHeader("", 0) + (isHttps ? "; Secure" : ""));
  return c.json({ ok: true });
});

// ============================================================================
// Public login-page config, self-service registration, email
// verification and password reset. Same mount point as login/guest/logout
// above (runs before the global authMiddleware) — a visitor without a
// session must be able to reach all of these.
// ============================================================================
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

webLoginRoutes.get("/edgesonic/auth/loginConfig", async (c) => {
  const [noticeText, backgroundUrl, registrationEnabled, allowPasswordReset, emailEnabled, activationEnabled, gateMode] = await Promise.all([
    getFeatureString(c.env, "login_notice_text", ""),
    getFeatureString(c.env, "login_background_url", ""),
    getFeature(c.env, "open_registration"),
    getFeature(c.env, "allow_email_password_reset"),
    emailSendingConfigured(c.env),
    getFeature(c.env, "enable_activation"),
    getRegistrationGateMode(c.env),
  ]);
  return c.json({
    ok: true,
    noticeText,
    backgroundUrl,
    // Self-service registration requires at least one signup gate: a working
    // verification email, or (activation system on) an invite code.
    registrationEnabled: registrationEnabled && (emailEnabled || activationEnabled),
    activationEnabled,
    registrationGateMode: gateMode,
    // Password reset has its own independent toggle on top of "is
    // email configured at all" — an operator may want registration without
    // self-service reset, or vice versa.
    passwordResetEnabled: allowPasswordReset && emailEnabled,
    emailEnabled,
    turnstileSiteKey: c.env.TURNSTILE_SECRET && c.env.TURNSTILE_SITE_KEY ? c.env.TURNSTILE_SITE_KEY : "",
    isDemo: isDemoMode(c.env),
  });
});

webLoginRoutes.post("/edgesonic/auth/register", async (c) => {
  if (isDemoMode(c.env)) {
    return c.json({ ok: false, error: "Registration is disabled in demo mode" }, 403);
  }
  if (!(await getFeature(c.env, "open_registration"))) {
    return c.json({ ok: false, error: "Registration is disabled" }, 403);
  }
  const emailConfigured = await emailSendingConfigured(c.env);
  const activationEnabled = await getFeature(c.env, "enable_activation");
  if (!emailConfigured && !activationEnabled) {
    return c.json({ ok: false, error: "Registration requires email to be configured" }, 403);
  }

  let body: { username?: string; email?: string; password?: string; inviteCode?: string; turnstileToken?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const username = (body.username || "").trim();
  const email = normalizeEmail(body.email || "");
  const password = body.password || "";
  const inviteCode = (body.inviteCode || "").trim();

  if (!USERNAME_RE.test(username) || username === GUEST_USERNAME) {
    return c.json({ ok: false, error: "Username must be 3-32 characters (letters, digits, _ or -)" }, 400);
  }
  if (email && !EMAIL_RE.test(email)) {
    return c.json({ ok: false, error: "Invalid email address" }, 400);
  }
  if (password.length < 8 || password.length > 256) {
    return c.json({ ok: false, error: "Password must be 8-256 characters" }, 400);
  }
  if (!(await verifyTurnstile(c.env, c.req.raw, body.turnstileToken, "register"))) {
    return c.json({ ok: false, error: "Verification failed" }, 403);
  }

  // Signup gate: which of the enabled options (email verification, invite
  // code) must be satisfied depends on registration_gate_mode.
  const gate = evaluateRegistrationGate({
    emailConfigured,
    activationEnabled,
    gateMode: await getRegistrationGateMode(c.env),
    hasEmail: EMAIL_RE.test(email),
    hasInvite: !!inviteCode,
  });
  if (!gate.ok) {
    return c.json({ ok: false, error: gate.error }, 400);
  }
  // A provided invite code must be redeemable even when the gate would pass
  // without it — silently ignoring a bad code would mislead the user.
  if (inviteCode) {
    const checked = await checkInviteCode(c.env, inviteCode);
    if ("error" in checked) {
      return c.json({ ok: false, error: checked.error }, 400);
    }
  }

  const db = c.env.DB;
  await ensureEmailColumns(c.env);
  await ensureActivationSchema(c.env);

  const existingUser = await db.prepare("SELECT username FROM users WHERE username = ?").bind(username).first();
  if (existingUser) {
    return c.json({ ok: true, username });
  }
  if (email) {
    const existingEmail = await db.prepare("SELECT username FROM users WHERE email = ?").bind(email).first();
    if (existingEmail) {
      return c.json({ ok: true, username });
    }
  }

  // With the activation system on a fresh account starts 'disabled'; a
  // supplied invite code flips it via the shared redemption path right after.
  const initialStatus = activationEnabled ? "disabled" : "permanent";
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    "INSERT INTO users (username, master_password, level, enabled, email, email_verified, activation_status, created_at, updated_at) VALUES (?, ?, 1, 1, ?, 0, ?, ?, ?)"
  ).bind(username, await hashWebPassword(password), email || null, initialStatus, now, now).run();

  if (activationEnabled && inviteCode) {
    const redeemed = await redeemCode(c.env, username, inviteCode);
    if (!redeemed.ok) {
      // Raced out (code exhausted/revoked between check and redeem): undo the
      // account creation so the caller can retry cleanly.
      await db.prepare("DELETE FROM users WHERE username = ?").bind(username).run();
      return c.json({ ok: false, error: redeemed.error }, 400);
    }
  }

  // Best-effort verification email — registration succeeds regardless of
  // whether sending works; the account is fully usable either way (email
  // verification is informational, not a login gate).
  if (email && emailConfigured) {
    const token = await createEmailToken(db, username, "verify", 24 * 60 * 60);
    const origin = new URL(c.req.url).origin;
    const tpl = await verifyEmailTemplate(c.env, origin, token);
    sendEmail(c.env, { to: email, ...tpl }).catch(() => {});
  }

  return c.json({ ok: true, username });
});

webLoginRoutes.post("/edgesonic/auth/passwordReset/request", async (c) => {
  let body: { emailOrUsername?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const query = (body.emailOrUsername || "").trim();
  const db = c.env.DB;
  await ensureEmailColumns(c.env);

  // Always ok:true regardless of whether an account was found — avoids
  // leaking which emails/usernames exist.
  if (!query) return c.json({ ok: true });

  // Independent on/off switch — off behaves exactly like "account not
  // found" (still ok:true, never sends), same as the demo-mode guard below.
  const allowReset = await getFeature(c.env, "allow_email_password_reset");

  const user = EMAIL_RE.test(query)
    ? await db.prepare("SELECT username, email FROM users WHERE email = ? AND enabled = 1")
        .bind(normalizeEmail(query)).first<{ username: string; email: string }>()
    : await db.prepare("SELECT username, email FROM users WHERE username = ? AND enabled = 1 AND email IS NOT NULL")
        .bind(query).first<{ username: string; email: string }>();

  // Demo mode: still succeed (no enumeration signal) but never actually
  // send — a public demo's Resend quota/reputation must not be spendable
  // by visitors.
  if (user && user.email && allowReset && !isDemoMode(c.env)) {
    const token = await createEmailToken(db, user.username, "reset", 60 * 60);
    const origin = new URL(c.req.url).origin;
    const tpl = await resetPasswordEmailTemplate(c.env, origin, token);
    sendEmail(c.env, { to: user.email, ...tpl }).catch(() => {});
  }
  return c.json({ ok: true });
});

webLoginRoutes.post("/edgesonic/auth/passwordReset/confirm", async (c) => {
  let body: { token?: string; newPassword?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (!body.token) {
    return c.json({ ok: false, error: "Missing token" }, 400);
  }
  const newPassword = body.newPassword || "";
  if (newPassword.length < 8 || newPassword.length > 256) {
    return c.json({ ok: false, error: "Password must be 8-256 characters" }, 400);
  }

  const db = c.env.DB;
  const username = await consumeEmailToken(db, body.token, "reset");
  if (!username) {
    return c.json({ ok: false, error: "Invalid or expired token" }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("UPDATE users SET master_password = ?, updated_at = ? WHERE username = ?")
    .bind(await hashWebPassword(newPassword), now, username).run();
  // Invalidate every existing session so a leaked/compromised session can't
  // outlive the password reset that was meant to shut it out.
  await db.prepare("DELETE FROM sessions WHERE username = ?").bind(username).run();

  return c.json({ ok: true, username });
});

webLoginRoutes.post("/edgesonic/auth/emailVerify/confirm", async (c) => {
  let body: { token?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (!body.token) {
    return c.json({ ok: false, error: "Missing token" }, 400);
  }
  const db = c.env.DB;
  await ensureEmailColumns(c.env);
  const username = await consumeEmailToken(db, body.token, "verify");
  if (!username) {
    return c.json({ ok: false, error: "Invalid or expired token" }, 400);
  }
  await db.prepare("UPDATE users SET email_verified = 1, updated_at = ? WHERE username = ?")
    .bind(Math.floor(Date.now() / 1000), username).run();
  return c.json({ ok: true, username });
});

// Confirming a pending email change. Public (no session required) since
// the link is opened from an email client that may not carry the caller's
// cookie — mirrors emailVerify/confirm above. The request side
// (emailChange/request, below in edgesonicAuthRoutes) never writes
// users.email itself; this confirm step is the only place that does, and it
// sets email_verified=1 in the same statement since clicking the link IS the
// proof the caller controls the new mailbox.
webLoginRoutes.post("/edgesonic/auth/emailChange/confirm", async (c) => {
  let body: { token?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (!body.token) {
    return c.json({ ok: false, error: "Missing token" }, 400);
  }
  const db = c.env.DB;
  await ensureEmailColumns(c.env);
  const result = await consumeEmailChangeToken(db, body.token);
  if (!result) {
    return c.json({ ok: false, error: "Invalid or expired token" }, 400);
  }
  // Re-check uniqueness at confirm time — the address could have been
  // claimed by someone else in the window between request and confirm.
  const clash = await db.prepare("SELECT username FROM users WHERE email = ? AND username != ?")
    .bind(result.newEmail, result.username).first();
  if (clash) {
    return c.json({ ok: false, error: "Email already in use" }, 409);
  }
  await db.prepare("UPDATE users SET email = ?, email_verified = 1, updated_at = ? WHERE username = ?")
    .bind(result.newEmail, Math.floor(Date.now() / 1000), result.username).run();
  return c.json({ ok: true, username: result.username, email: result.newEmail });
});

function parseSessionCookie(cookieHeader: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === SESSION_COOKIE && v) return v;
  }
  return null;
}

export const edgesonicAuthRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;

// ─── Current user (identity + effective permissions) ────────────────────────
// The SPA gates navigation and settings by real capability, not just level.
// This returns the caller's effective permission map (env override → D1) plus
// their display name and avatar so App.vue / Settings can render accordingly.
edgesonicAuthRoutes.get("/auth/me", async (c) => {
  const user = c.get("user");
  await ensureNicknameColumn(c.env);
  await ensureEmailColumns(c.env);
  await ensureSubsonicMasterPasswordNoticeColumn(c.env);
  const permissions = await getEffectivePermissions(c.env, user);

  let nickname: string | null = null;
  let avatarKey: string | null = null;
  let email: string | null = null;
  let emailVerified = false;
  let subsonicMasterPasswordNotice = false;
  try {
    const row = await c.env.DB
      .prepare("SELECT nickname, avatar_r2_key, email, email_verified FROM users WHERE username = ?")
      .bind(user.username)
      .first<{ nickname: string | null; avatar_r2_key: string | null; email: string | null; email_verified: number }>();
    nickname = row?.nickname ?? null;
    avatarKey = row?.avatar_r2_key ?? null;
    email = row?.email ?? null;
    emailVerified = !!row?.email_verified;
  } catch {
    // nickname/email columns may be absent on a database not yet back-filled.
  }

  try {
    const row = await c.env.DB.prepare(
      "SELECT subsonic_master_password_notice_at FROM users WHERE username = ?",
    ).bind(user.username).first<{ subsonic_master_password_notice_at: number | null }>();
    subsonicMasterPasswordNotice = row?.subsonic_master_password_notice_at !== null
      && row?.subsonic_master_password_notice_at !== undefined;
    if (subsonicMasterPasswordNotice) {
      await c.env.DB.prepare(
        "UPDATE users SET subsonic_master_password_notice_at = NULL WHERE username = ?",
      ).bind(user.username).run();
    }
  } catch {
    // If a legacy database cannot be upgraded yet, omit the optional notice.
  }

  const activation = await resolveActivation(c.env, user);
  return c.json({
    ok: true,
    username: user.username,
    level: user.level,
    nickname,
    avatarKey,
    email,
    emailVerified,
    permissions,
    subsonicMasterPasswordNotice: subsonicMasterPasswordNotice
      ? (permissions.manage_credentials ? "create_client_password" : "clients_not_enabled")
      : null,
    activation: {
      enabled: activation.enabled,
      status: activation.status,
      until: activation.until,
      active: activation.active,
    },
  });
});

// ─── Email change ─────────────────────────────────────────────────────────
// Two-step, unlike the old updateSelf path it replaces: this endpoint
// never writes users.email. It only verifies the caller's CURRENT password
// (so a hijacked-but-not-yet-expired session can't silently redirect
// password-reset mail to an attacker's inbox) and mails a confirmation link
// to the NEW address; /auth/emailChange/confirm (public, above) is what
// actually writes the row, once the caller has proven they control the new
// mailbox too.
edgesonicAuthRoutes.post("/auth/emailChange/request", async (c) => {
  const caller = c.get("user");
  if (caller.level < 1) {
    return c.json({ ok: false, error: "Guests cannot edit their profile" }, 403);
  }
  if (isDemoMode(c.env)) {
    // Same spam-relay concern as registration: a demo visitor could otherwise
    // mail an arbitrary address using the operator's Resend quota.
    return c.json({ ok: false, error: "Email change is disabled in demo mode" }, 403);
  }
  if (!(await emailSendingConfigured(c.env))) {
    return c.json({ ok: false, error: "Email is not configured on this server" }, 403);
  }

  let body: { currentPassword?: string; newEmail?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const newEmail = normalizeEmail(body.newEmail || "");
  if (!EMAIL_RE.test(newEmail)) {
    return c.json({ ok: false, error: "Invalid email address" }, 400);
  }

  const db = c.env.DB;
  await ensureEmailColumns(c.env);
  const row = await db.prepare("SELECT master_password FROM users WHERE username = ?")
    .bind(caller.username).first<{ master_password: string }>();
  if (!row || !(await verifyWebPassword(body.currentPassword || "", row.master_password)).valid) {
    return c.json({ ok: false, error: "Current password is incorrect" }, 401);
  }

  const clash = await db.prepare("SELECT username FROM users WHERE email = ? AND username != ?")
    .bind(newEmail, caller.username).first();
  if (clash) {
    return c.json({ ok: false, error: "Email already in use" }, 409);
  }

  const token = await createEmailToken(db, caller.username, "change_email", 24 * 60 * 60, newEmail);
  const origin = new URL(c.req.url).origin;
  const tpl = await changeEmailTemplate(c.env, origin, token);
  sendEmail(c.env, { to: newEmail, ...tpl }).catch(() => {});

  return c.json({ ok: true });
});

// ─── Sessions ───────────────────────────────────────────────────────────────
edgesonicAuthRoutes.get("/auth/sessions/list", async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const rows = await db.prepare(
    "SELECT id, user_agent, expires_at, created_at FROM sessions WHERE username = ? AND expires_at > ? ORDER BY created_at DESC"
  ).bind(user.username, Math.floor(Date.now() / 1000)).all<{ id: string; user_agent: string | null; expires_at: number; created_at: number }>();

  return c.text(
    subsonicOK({
      sessions: {
        session: rows.results.map((r) => ({
          _attributes: {
            id: r.id,
            userAgent: r.user_agent || "",
            expiresAt: String(r.expires_at),
            createdAt: String(r.created_at),
          },
        })),
      },
    }),
    200, XML,
  );
});

edgesonicAuthRoutes.post("/auth/sessions/revoke", async (c) => {
  const body = await c.req.json<{ id?: string }>().catch(() => ({} as { id?: string }));
  if (!body.id) {
    return c.text(subsonicError(0, "Missing id"), 400, XML);
  }
  const db = c.env.DB;
  const user = c.get("user");
  const row = await db.prepare("SELECT token FROM sessions WHERE id = ? AND username = ?")
    .bind(body.id, user.username).first<{ token: string }>();
  if (!row) {
    return c.text(subsonicError(70, "Session not found"), 404, XML);
  }
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(body.id).run();
  return c.text(subsonicOK({}), 200, XML);
});

// ─── Subsonic Credentials ────────────────────────────────────────────────────
edgesonicAuthRoutes.get("/auth/credentials/list", permissionMiddleware("manage_credentials"), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const rows = await db.prepare(
    "SELECT id, label, last_used, created_at, stream_proxy_strategy FROM subsonic_credentials WHERE username = ? ORDER BY created_at ASC"
  ).bind(user.username).all<{ id: string; label: string | null; last_used: number | null; created_at: number; stream_proxy_strategy: string | null }>();

  return c.text(
    subsonicOK({
      subsonicCredentials: {
        credential: rows.results.map((r) => ({
          _attributes: {
            id: r.id,
            label: r.label || "",
            lastUsed: r.last_used ? String(r.last_used) : "0",
            createdAt: String(r.created_at),
            streamProxyStrategy: r.stream_proxy_strategy || "always",
          },
        })),
      },
    }),
    200, XML,
  );
});

edgesonicAuthRoutes.post("/auth/credentials/create", permissionMiddleware("manage_credentials"), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");

  const count = await db.prepare(
    "SELECT COUNT(*) AS cnt FROM subsonic_credentials WHERE username = ?"
  ).bind(user.username).first<{ cnt: number }>();
  if (count && count.cnt >= 64) {
    return c.text(subsonicError(0, "Maximum 64 Subsonic credentials per user"), 400, XML);
  }

  const body = await c.req.json<{ password: string; label?: string; streamProxyStrategy?: string }>();
  if (!body.password) {
    return c.text(subsonicError(0, "Missing password"), 400, XML);
  }

  const strategy = body.streamProxyStrategy || "always";
  if (!["always", "never", "r2_only", "webdav_only"].includes(strategy)) {
    return c.text(subsonicError(0, "Invalid streamProxyStrategy (always|never|r2_only|webdav_only)"), 400, XML);
  }

  const id = crypto.randomUUID().substring(0, 12);
  const now = Math.floor(Date.now() / 1000);
  // Issued against the account's current activation horizon; a later change
  // re-stamps it rather than requiring a new credential.
  await ensureActivationSchema(c.env);
  const expiresAt = credentialExpiryFor(await resolveActivation(c.env, user));
  await db.prepare(
    "INSERT INTO subsonic_credentials (id, username, password, label, stream_proxy_strategy, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, user.username, body.password, body.label || "", strategy, now, expiresAt).run();

  return c.text(
    subsonicOK({
      credential: { _attributes: { id, label: body.label || "", streamProxyStrategy: strategy } },
    }),
    200, XML,
  );
});

// on Pixel 9"). Doesn't touch the password or last_used; just lets the user
// keep their device registry tidy.
//  - body: { id, label }
//  - username pinned to the session user — UPDATE WHERE id=? AND username=?
//   ensures one user can never relabel another user's credential, and
//   skips the need for a separate "exists & owned" lookup.
//  - label must be a non-null string ≤200 chars; we allow empty to clear.
//  - meta.changes === 0 means no row matched → either bogus id or someone
//   else's credential. Both are surfaced as 404 (consistent with the
//   sessions/revoke handler above).
edgesonicAuthRoutes.post("/auth/credentials/update", permissionMiddleware("manage_credentials"), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");

  let body: { id?: string; label?: string; streamProxyStrategy?: string };
  try {
    body = await c.req.json<{ id?: string; label?: string; streamProxyStrategy?: string }>();
  } catch {
    return c.text(subsonicError(0, "Invalid JSON body"), 400, XML);
  }

  if (!body.id) {
    return c.text(subsonicError(0, "Missing credential id"), 400, XML);
  }
  if (typeof body.label !== "string") {
    return c.text(subsonicError(0, "Missing label"), 400, XML);
  }
  if (body.label.length > 200) {
    return c.text(subsonicError(0, "Label too long (max 200 chars)"), 400, XML);
  }

  // unchanged (so the label-only rename path stays a single-column UPDATE).
  const strategy = body.streamProxyStrategy;
  if (strategy !== undefined && !["always", "never", "r2_only", "webdav_only"].includes(strategy)) {
    return c.text(subsonicError(0, "Invalid streamProxyStrategy (always|never|r2_only|webdav_only)"), 400, XML);
  }

  const result = strategy === undefined
    ? await db.prepare(
        "UPDATE subsonic_credentials SET label = ? WHERE id = ? AND username = ?",
      ).bind(body.label, body.id, user.username).run()
    : await db.prepare(
        "UPDATE subsonic_credentials SET label = ?, stream_proxy_strategy = ? WHERE id = ? AND username = ?",
      ).bind(body.label, strategy, body.id, user.username).run();

  if (!result.meta.changes) {
    return c.text(subsonicError(70, "Credential not found"), 404, XML);
  }

  return c.text(
    subsonicOK({
      credential: { _attributes: { id: body.id, label: body.label, streamProxyStrategy: strategy ?? undefined } },
    }),
    200, XML,
  );
});

edgesonicAuthRoutes.post("/auth/credentials/delete", permissionMiddleware("manage_credentials"), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const body = await c.req.json<{ id: string }>();
  if (!body.id) {
    return c.text(subsonicError(0, "Missing credential id"), 400, XML);
  }
  await db.prepare(
    "DELETE FROM subsonic_credentials WHERE id = ? AND username = ?"
  ).bind(body.id, user.username).run();
  return c.text(subsonicOK({}), 200, XML);
});

// ─── Guest tokens ───────────────────────────────────────────────────────────
edgesonicAuthRoutes.post("/auth/guestToken", permissionMiddleware("manage_users"), async (c) => {
  const body = await c.req.json<{ expiresIn?: number }>();
  const db = c.env.DB;
  const user = c.get("user");
  // Cap lifetime at 30 days. A missing/undefined expiresIn falls back to the
  // 1-day default; an explicit zero/negative is rejected; anything above the
  // cap is clamped so a fat-fingered `expiresIn: 31536000` can't mint a token
  // that effectively never expires.
  const MAX_GUEST_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;
  const requestedTtl = typeof body.expiresIn === "number" ? body.expiresIn : 86400;
  if (!Number.isFinite(requestedTtl) || requestedTtl <= 0) {
    return c.json({ ok: false, error: "expiresIn must be a positive number of seconds" }, 400);
  }
  const ttlSec = Math.min(Math.floor(requestedTtl), MAX_GUEST_TOKEN_TTL_SEC);
  const token = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSec;

  await db.prepare(
    "INSERT INTO guest_tokens (token, created_by, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).bind(token, user.username, expiresAt, Math.floor(Date.now() / 1000)).run();

  return c.text(
    subsonicOK({
      guestToken: {
        _attributes: {
          token,
          expiresAt: String(expiresAt),
        },
      },
    }),
    200, XML,
  );
});
