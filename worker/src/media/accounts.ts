// SPDX-License-Identifier: AGPL-3.0-or-later
import { MediaLoaderError, requestMedia } from "./loader";
import type { ExternalProvider } from "./references";

type Profile = { id?: string; displayName?: string };
interface StoredAccount { revision: string; ciphertext: string; iv: string; updatedAt: number; profile?: Profile }
const encoder = new TextEncoder();
const accountKey = (username: string, provider: ExternalProvider) => `media_account:${encodeURIComponent(username)}:${provider}`;
export function accountStorageAvailable(env: Env): boolean { return !!env.MediaContainer; }

export function validateCookies(provider: ExternalProvider, input: string): string {
  if (encoder.encode(input).length > 65_536 || !input.trim()) throw new MediaLoaderError("Cookie file must be nonempty and at most 64 KiB", 400);
  const lines: string[] = ["# Netscape HTTP Cookie File"];
  let hasLogin = false;
  for (const raw of input.split(/\r?\n/)) {
    if (!raw.trim() || (raw.startsWith("#") && !raw.startsWith("#HttpOnly_"))) continue;
    const fields = raw.replace(/^#HttpOnly_/, "").split("\t");
    if (fields.length !== 7 || fields.some((field) => /[\r\n\0]/.test(field))) throw new MediaLoaderError("Use a Netscape cookies.txt file", 400);
    const host = fields[0].replace(/^\./, "").toLowerCase();
    const allowed = provider === "bilibili" ? ["bilibili.com"] : ["youtube.com", "google.com"];
    if (!allowed.some((domain) => host === domain || host.endsWith(`.${domain}`))) continue;
    if (!/^\d+$/.test(fields[4]) || !["TRUE", "FALSE"].includes(fields[1]) || !["TRUE", "FALSE"].includes(fields[3]) || !fields[2].startsWith("/")) throw new MediaLoaderError("Invalid cookie file", 400);
    if (Number(fields[4]) && Number(fields[4]) <= Date.now() / 1000) continue;
    const loginNames = provider === "bilibili" ? ["SESSDATA"] : ["SID", "__Secure-1PSID", "__Secure-3PSID", "LOGIN_INFO"];
    if (loginNames.includes(fields[5]) && fields[6]) hasLogin = true;
    lines.push(raw);
  }
  if (!hasLogin) throw new MediaLoaderError("No unexpired platform login cookies were found", 400);
  return `${lines.join("\n")}\n`;
}

export async function saveAccount(env: Env, username: string, provider: ExternalProvider, input: string, profile?: Profile): Promise<void> {
  const cookies = validateCookies(provider, input);
  if (!env.MediaContainer) throw new MediaLoaderError("Platform authorization requires the integrated media container", 503);
  const storageKey = accountKey(username, provider);
  const encrypted = await env.MediaContainer.getByName("media").encryptAccount(cookies, storageKey);
  await revokeMediaSessions(env, username);
  const record: StoredAccount = { ...encrypted, revision: crypto.randomUUID(), updatedAt: Date.now(), profile };
  await env.DB.prepare("INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(storageKey, JSON.stringify(record)).run();
}

export async function accountRevision(env: Env, username: string, provider: ExternalProvider): Promise<string> {
  const row = await env.DB.prepare("SELECT json_extract(value, '$.revision') AS revision FROM kv_store WHERE key = ?").bind(accountKey(username, provider)).first<{ revision: string }>();
  return row?.revision || "";
}

export async function accountCookies(env: Env, username: string, provider: ExternalProvider): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT value FROM kv_store WHERE key = ?").bind(accountKey(username, provider)).first<{ value: string }>();
  if (!row) return undefined;
  try {
    const record = JSON.parse(row.value) as StoredAccount;
    if (!env.MediaContainer) throw new Error("Media container is unavailable");
    return validateCookies(provider, await env.MediaContainer.getByName("media").decryptAccount(record, accountKey(username, provider)));
  } catch { throw new MediaLoaderError("Platform session expired or cannot be read; authorize again or disconnect it", 401); }
}

export async function accountStatus(env: Env, username: string, provider: ExternalProvider) {
  const row = await env.DB.prepare("SELECT value FROM kv_store WHERE key = ?").bind(accountKey(username, provider)).first<{ value: string }>();
  if (!row) return { provider, connected: false };
  const record = JSON.parse(row.value) as StoredAccount;
  let usable = false;
  try { usable = !!await accountCookies(env, username, provider); } catch { /* expired sessions require explicit renewal */ }
  return { provider, connected: usable, needsAuthorization: !usable, updatedAt: record.updatedAt, profile: record.profile };
}

async function revokeMediaSessions(env: Env, username: string): Promise<void> {
  const rows = await env.DB.prepare("SELECT key, value FROM kv_store WHERE key LIKE 'media_session:%' AND json_extract(value, '$.username') = ? LIMIT 500").bind(username).all<{ key: string; value: string }>();
  for (const row of rows.results) {
    const id = row.key.slice("media_session:".length);
    if (env.MediaContainer && /^[A-Za-z0-9_-]{16,128}$/.test(id)) await requestMedia(env, `/media/sessions/${id}`, { method: "DELETE", signal: AbortSignal.timeout(5000) }).then((response) => response.body?.cancel()).catch(() => undefined);
  }
  await env.DB.prepare("DELETE FROM kv_store WHERE (key LIKE 'media_session:%' OR key LIKE 'video_session:%') AND json_extract(value, '$.username') = ?").bind(username).run();
}
export async function removeAccount(env: Env, username: string, provider: ExternalProvider): Promise<void> {
  await env.DB.prepare("DELETE FROM kv_store WHERE key = ?").bind(accountKey(username, provider)).run();
  await env.DB.prepare("DELETE FROM kv_store WHERE key LIKE 'media_qr:%' AND json_extract(value, '$.username') = ?").bind(username).run();
  await revokeMediaSessions(env, username);
}
