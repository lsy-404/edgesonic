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

// Resend-backed transactional email (email verification link,
// password reset link, email-change confirmation link). Configuration: the
// API key is a secret and lives in external_secrets.resend_api_key (masked
// via /features/secrets/get|set, never round-tripped to the client — see
// features.ts); the from-address parts are non-secret and live in
// feature_strings.resend_from_email / resend_from_name. An empty from-email
// means sending is disabled; callers treat send failures as best-effort and
// never fail the outer request on them.
//
// Templates (email_tpl_{verify,reset,change}_{subject,body}) are editable by
// a super-admin only (enforced in features.ts, not just manage_settings) and
// stored as plain text with a {{link}} placeholder — see renderTemplate.
import { getFeatureString } from "./features";

const RESEND_API_URL = "https://api.resend.com/emails";
const FETCH_TIMEOUT_MS = 10_000;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

async function getResendApiKey(env: { DB: D1Database }): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM external_secrets WHERE key = ?")
    .bind("resend_api_key").first<{ value: string }>();
  return row?.value || "";
}

export async function emailSendingConfigured(env: Env): Promise<boolean> {
  const [apiKey, fromEmail] = await Promise.all([
    getResendApiKey(env),
    getFeatureString(env, "resend_from_email", ""),
  ]);
  return !!(apiKey && fromEmail);
}

export interface SendEmailResult { ok: boolean; error?: string; }

export async function sendEmail(
  env: Env,
  opts: { to: string; subject: string; html: string; text: string },
): Promise<SendEmailResult> {
  const [apiKey, fromEmail, fromName] = await Promise.all([
    getResendApiKey(env),
    getFeatureString(env, "resend_from_email", ""),
    getFeatureString(env, "resend_from_name", "EdgeSonic"),
  ]);
  if (!apiKey || !fromEmail) return { ok: false, error: "Email sending is not configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${fromName} <${fromEmail}>`,
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Resend HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? `Resend fetch failed: ${e.message}` : "Resend fetch failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// Single-use tokens (email verification / password reset / email change)
// ============================================================================
// email_tokens is declared in Schema.sql for fresh installs; existing
// deployments create/upgrade it lazily here on first use (same idempotent
// self-heal pattern as autoupdate_state — see Schema.sql's comment above
// that table). The current shape added `new_email` + the `change_email`
// purpose; SQLite cannot ALTER a CHECK constraint in place, so an existing
// older table is detected via its stored DDL and dropped before the CREATE below
// recreates it in the new shape. Tokens are short-lived (1-24h) and purely
// transactional, so losing a handful of in-flight links across the upgrade
// is an acceptable one-time cost (the user just re-requests the link).
let emailTokensTableEnsured = false;
async function ensureEmailTokensTable(db: D1Database): Promise<void> {
  if (emailTokensTableEnsured) return;
  try {
    const existing = await db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'email_tokens'"
    ).first<{ sql: string }>();
    if (existing && !/change_email/.test(existing.sql)) {
      await db.prepare("DROP TABLE email_tokens").run();
    }
  } catch {
    // sqlite_master probe failing isn't fatal — fall through to the
    // idempotent CREATE below, which no-ops if a compatible table exists.
  }
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS email_tokens (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset', 'change_email')),
      new_email TEXT,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
    )`
  ).run();
  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_email_tokens_username ON email_tokens(username, purpose)"
  ).run();
  emailTokensTableEnsured = true;
}

export type EmailTokenPurpose = "verify" | "reset" | "change_email";

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

// `newEmail` is only meaningful (and only ever read back) for purpose
// 'change_email' — see consumeEmailChangeToken.
export async function createEmailToken(
  db: D1Database,
  username: string,
  purpose: EmailTokenPurpose,
  ttlSec: number,
  newEmail?: string,
): Promise<string> {
  await ensureEmailTokensTable(db);
  const token = randomToken();
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    "INSERT INTO email_tokens (token, username, purpose, new_email, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(token, username, purpose, newEmail ?? null, now + ttlSec, now).run();
  return token;
}

// Consumes (marks used) a token on success. Returns the owning username, or
// null if the token is missing/expired/already used/wrong purpose. Used for
// 'verify' and 'reset' — 'change_email' additionally needs the pending
// address, see consumeEmailChangeToken below.
export async function consumeEmailToken(
  db: D1Database,
  token: string,
  purpose: EmailTokenPurpose,
): Promise<string | null> {
  await ensureEmailTokensTable(db);
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare(
    "SELECT username FROM email_tokens WHERE token = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?"
  ).bind(token, purpose, now).first<{ username: string }>();
  if (!row) return null;
  await db.prepare("UPDATE email_tokens SET used_at = ? WHERE token = ?").bind(now, token).run();
  return row.username;
}

// Confirming an email change is also the proof that the caller controls
// the new mailbox — the endpoint that calls this writes users.email AND
// flips email_verified=1 in the same step, no separate verify round-trip.
export async function consumeEmailChangeToken(
  db: D1Database,
  token: string,
): Promise<{ username: string; newEmail: string } | null> {
  await ensureEmailTokensTable(db);
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare(
    "SELECT username, new_email FROM email_tokens WHERE token = ? AND purpose = 'change_email' AND used_at IS NULL AND expires_at > ?"
  ).bind(token, now).first<{ username: string; new_email: string | null }>();
  if (!row || !row.new_email) return null;
  await db.prepare("UPDATE email_tokens SET used_at = ? WHERE token = ?").bind(now, token).run();
  return { username: row.username, newEmail: row.new_email };
}

// ============================================================================
// Templates — super-admin-editable (feature_strings), plain text + {{link}}
// ============================================================================
interface EmailContent { subject: string; html: string; text: string; }

const DEFAULT_TEMPLATES = {
  verify: {
    subject: "Verify your EdgeSonic email / 验证你的 EdgeSonic 邮箱",
    body: "Confirm your email address by visiting the link below:\n\n{{link}}\n\n"
      + "请访问以下链接验证邮箱：\n\n{{link}}\n\n"
      + "This link expires in 24 hours / 链接 24 小时后失效。",
  },
  reset: {
    subject: "Reset your EdgeSonic password / 重置你的 EdgeSonic 密码",
    body: "Reset your password by visiting the link below:\n\n{{link}}\n\n"
      + "请访问以下链接重置密码：\n\n{{link}}\n\n"
      + "If you did not request this, ignore this email. This link expires in 1 hour / 若非本人操作请忽略，链接 1 小时后失效。",
  },
  change: {
    subject: "Confirm your new EdgeSonic email / 确认你的新 EdgeSonic 邮箱",
    body: "Confirm your new email address by visiting the link below:\n\n{{link}}\n\n"
      + "请访问以下链接确认新邮箱：\n\n{{link}}\n\n"
      + "This link expires in 24 hours / 链接 24 小时后失效。",
  },
} as const;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Plain-text template body → simple HTML paragraphs (blank-line-separated).
// Templates are super-admin-authored but still escaped — a template is not
// allowed to inject raw markup/script, it can only affect the wording.
function textToHtml(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

async function renderTemplate(
  env: Env,
  kind: keyof typeof DEFAULT_TEMPLATES,
  link: string,
): Promise<EmailContent> {
  const defaults = DEFAULT_TEMPLATES[kind];
  const [subjectRaw, bodyRaw] = await Promise.all([
    getFeatureString(env, `email_tpl_${kind}_subject`, defaults.subject),
    getFeatureString(env, `email_tpl_${kind}_body`, defaults.body),
  ]);
  const subject = (subjectRaw || defaults.subject).replace(/[\r\n]+/g, " ").trim();
  const body = (bodyRaw || defaults.body).replace(/\{\{link\}\}/g, link);
  return { subject, text: body, html: textToHtml(body) };
}

export async function verifyEmailTemplate(env: Env, origin: string, token: string): Promise<EmailContent> {
  const link = `${origin}/#/verify-email?token=${encodeURIComponent(token)}`;
  return renderTemplate(env, "verify", link);
}

export async function resetPasswordEmailTemplate(env: Env, origin: string, token: string): Promise<EmailContent> {
  const link = `${origin}/#/reset-password?token=${encodeURIComponent(token)}`;
  return renderTemplate(env, "reset", link);
}

export async function changeEmailTemplate(env: Env, origin: string, token: string): Promise<EmailContent> {
  const link = `${origin}/#/confirm-email-change?token=${encodeURIComponent(token)}`;
  return renderTemplate(env, "change", link);
}
