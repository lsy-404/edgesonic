import { GITHUB_API, type GithubRelease } from "../../../shared/autoupdate";
import type { User } from "../types/entities";

export const MESSAGE_KINDS = ["info", "notice", "warning"] as const;
export const MESSAGE_PRESENTATIONS = ["inbox", "modal"] as const;

export type MessageKind = typeof MESSAGE_KINDS[number];
export type MessagePresentation = typeof MESSAGE_PRESENTATIONS[number];

export type UserMessage = {
  id: string;
  title: string;
  body: string;
  kind: MessageKind;
  presentation: MessagePresentation;
  source: "admin" | "system" | "official";
  createdAt: string;
  readAt: string | null;
  dismissedAt: string | null;
};

let messagesSchemaEnsured = false;

export async function ensureUserMessagesSchema(env: { DB: D1Database }): Promise<void> {
  if (messagesSchemaEnsured) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_messages (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('admin', 'system', 'official')),
    kind TEXT NOT NULL CHECK (kind IN ('info', 'notice', 'warning')),
    presentation TEXT NOT NULL CHECK (presentation IN ('inbox', 'modal')),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    dedupe_key TEXT,
    read_at INTEGER,
    dismissed_at INTEGER,
    created_at INTEGER NOT NULL
  )`).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_user_messages_user_created ON user_messages(username, created_at DESC)",
  ).run();
  await env.DB.prepare(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_user_messages_dedupe ON user_messages(username, dedupe_key) WHERE dedupe_key IS NOT NULL",
  ).run();
  messagesSchemaEnsured = true;
}

export async function createUserMessage(
  env: { DB: D1Database },
  input: {
    username: string;
    source: UserMessage["source"];
    kind: MessageKind;
    presentation: MessagePresentation;
    title: string;
    body: string;
    dedupeKey?: string;
  },
): Promise<void> {
  await ensureUserMessagesSchema(env);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO user_messages (id, username, source, kind, presentation, title, body, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    crypto.randomUUID(), input.username, input.source, input.kind, input.presentation,
    input.title, input.body, input.dedupeKey || null, Math.floor(Date.now() / 1000),
  ).run();
}

export async function ensureActivationExpiryMessage(
  env: { DB: D1Database },
  user: User,
): Promise<void> {
  const until = user.activation_status === "active_until" ? user.activated_until : null;
  const now = Math.floor(Date.now() / 1000);
  const warningWindow = 7 * 24 * 60 * 60;
  if (typeof until !== "number" || until <= now || until > now + warningWindow) return;
  const days = Math.max(1, Math.ceil((until - now) / 86400));
  await createUserMessage(env, {
    username: user.username,
    source: "system",
    kind: "warning",
    presentation: "modal",
    title: "Account activation is ending soon",
    body: `Your account will be disabled in ${days} day${days === 1 ? "" : "s"}. Redeem an activation code to keep access.`,
    dedupeKey: `activation-expiring:${until}`,
  });
}

let officialReleaseCache: { until: number; release: GithubRelease | null } | null = null;

async function latestOfficialRelease(env: { GITHUB_TOKEN?: string }): Promise<GithubRelease | null> {
  const now = Date.now();
  if (officialReleaseCache && officialReleaseCache.until > now) return officialReleaseCache.release;
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "EdgeSonic-Messages",
    };
    if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
    const response = await fetch(`${GITHUB_API}/releases/latest`, { headers });
    if (!response.ok) throw new Error(`GitHub release lookup failed (${response.status})`);
    const release = await response.json() as GithubRelease;
    officialReleaseCache = { until: now + 5 * 60 * 1000, release: release.tag_name ? release : null };
  } catch {
    officialReleaseCache = { until: now + 60 * 1000, release: null };
  }
  return officialReleaseCache.release;
}

export async function ensureOfficialReleaseMessage(
  env: { DB: D1Database; GITHUB_TOKEN?: string },
  user: User,
): Promise<void> {
  if (user.level < 3) return;
  const release = await latestOfficialRelease(env);
  if (!release?.tag_name) return;
  const title = `Official update: ${release.name || release.tag_name}`.slice(0, 200);
  const body = (release.body || `Release ${release.tag_name} is available on GitHub.`).slice(0, 4000);
  await createUserMessage(env, {
    username: user.username,
    source: "official",
    kind: "notice",
    presentation: "modal",
    title,
    body,
    dedupeKey: `github-release:${release.tag_name}`,
  });
}

export async function listUserMessages(env: { DB: D1Database }, username: string): Promise<UserMessage[]> {
  await ensureUserMessagesSchema(env);
  const rows = await env.DB.prepare(
    "SELECT id, source, kind, presentation, title, body, read_at, dismissed_at, created_at FROM user_messages WHERE username = ? AND dismissed_at IS NULL ORDER BY created_at DESC LIMIT 100",
  ).bind(username).all<{
    id: string; source: UserMessage["source"]; kind: MessageKind; presentation: MessagePresentation;
    title: string; body: string; read_at: number | null; dismissed_at: number | null; created_at: number;
  }>();
  return rows.results.map((row) => ({
    id: row.id, source: row.source, kind: row.kind, presentation: row.presentation,
    title: row.title,
    body: row.body,
    readAt: row.read_at === null ? null : new Date(row.read_at * 1000).toISOString(),
    dismissedAt: row.dismissed_at === null ? null : new Date(row.dismissed_at * 1000).toISOString(),
    createdAt: new Date(row.created_at * 1000).toISOString(),
  }));
}
