import { marked, Renderer } from "marked";
import { GITHUB_API, GITHUB_REPO, compareSemver, parseSemver, type GithubRelease } from "../../../shared/autoupdate";
import { currentVersion } from "./autoupdate";
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
  bodyHtml: string;
};

type OfficialAnnouncement = {
  id: string;
  title: string;
  body: string;
  kind: MessageKind;
  presentation: MessagePresentation;
  publishedAt?: string;
};

const OFFICIAL_ANNOUNCEMENTS_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/official-announcements.json`;

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
let officialAnnouncementsCache: { until: number; announcements: OfficialAnnouncement[] } | null = null;

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

function renderOfficialMarkdown(markdown: string): string {
  const renderer = new Renderer();
  renderer.html = () => "";
  renderer.image = () => "";
  renderer.link = function({ href, title, tokens }) {
    let url: URL;
    try { url = new URL(href); } catch { return this.parser.parseInline(tokens); }
    if (url.protocol !== "https:") return this.parser.parseInline(tokens);
    const label = this.parser.parseInline(tokens);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapeHtml(url.href)}"${titleAttr} target="_blank" rel="noopener noreferrer">${label}</a>`;
  };
  return marked.parse(markdown.slice(0, 4000), { async: false, breaks: true, gfm: true, renderer }) as string;
}

function renderPlainText(value: string): string {
  return `<p>${escapeHtml(value).replace(/\r?\n/g, "<br>")}</p>`;
}

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

function parseAnnouncements(input: unknown): OfficialAnnouncement[] {
  const entries = (input as { announcements?: unknown })?.announcements;
  if (!Array.isArray(entries)) return [];
  const accepted: OfficialAnnouncement[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const id = typeof value.id === "string" ? value.id.trim() : "";
    const title = typeof value.title === "string" ? value.title.trim() : "";
    const body = typeof value.body === "string" ? value.body.trim() : "";
    const kind = typeof value.kind === "string" ? value.kind : "notice";
    const presentation = typeof value.presentation === "string" ? value.presentation : "inbox";
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(id) || !title || !body || title.length > 200 || body.length > 4000) continue;
    if (!MESSAGE_KINDS.includes(kind as MessageKind) || !MESSAGE_PRESENTATIONS.includes(presentation as MessagePresentation)) continue;
    accepted.push({ id, title, body, kind: kind as MessageKind, presentation: presentation as MessagePresentation });
  }
  return accepted;
}

async function officialAnnouncements(env: { GITHUB_TOKEN?: string }): Promise<OfficialAnnouncement[]> {
  const now = Date.now();
  if (officialAnnouncementsCache && officialAnnouncementsCache.until > now) return officialAnnouncementsCache.announcements;
  try {
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "EdgeSonic-Messages" };
    if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
    const response = await fetch(OFFICIAL_ANNOUNCEMENTS_URL, { headers });
    if (response.status === 404) {
      officialAnnouncementsCache = { until: now + 5 * 60 * 1000, announcements: [] };
      return [];
    }
    if (!response.ok) throw new Error(`GitHub announcement lookup failed (${response.status})`);
    const announcements = parseAnnouncements(await response.json());
    officialAnnouncementsCache = { until: now + 5 * 60 * 1000, announcements };
  } catch {
    officialAnnouncementsCache = { until: now + 60 * 1000, announcements: [] };
  }
  return officialAnnouncementsCache.announcements;
}

export function clearOfficialMessageCaches(): void {
  officialReleaseCache = null;
  officialAnnouncementsCache = null;
}

export async function ensureOfficialMessages(
  env: Env,
  user: User,
  requestUrl: string,
): Promise<void> {
  if (user.level < 3) return;
  const [announcements, release, running] = await Promise.all([
    officialAnnouncements(env), latestOfficialRelease(env), currentVersion(env, requestUrl),
  ]);
  for (const announcement of announcements) {
    await createUserMessage(env, {
      username: user.username, source: "official", kind: announcement.kind, presentation: announcement.presentation,
      title: announcement.title, body: announcement.body, dedupeKey: `github-announcement:${announcement.id}`,
    });
  }
  const releaseVersion = release?.tag_name ? parseSemver(release.tag_name) : null;
  if (!release || !releaseVersion || compareSemver(releaseVersion, running) <= 0) return;
  await createUserMessage(env, {
    username: user.username,
    source: "official",
    kind: "notice",
    presentation: "inbox",
    title: `Official update: ${release.name || release.tag_name}`.slice(0, 200),
    body: (release.body || `Release ${release.tag_name} is available on GitHub.`).slice(0, 4000),
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
    bodyHtml: row.source === "official" ? renderOfficialMarkdown(row.body) : renderPlainText(row.body),
  }));
}
