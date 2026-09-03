import { limitReadableStream } from "./streamLimit";

const READ_ONLY_METHODS = new Set([
  "getAlbum", "getAlbumList2", "getPlaylists", "getPlaylist", "getStarred2",
  "getUsers", "search3", "star", "stream",
]);
const PROXY_WINDOW_SECONDS = 60;
export const CLONE_PROXY_RPM = 30;

export function safeCloneTarget(baseUrl: string, path: string): URL | null {
  if (!READ_ONLY_METHODS.has(path)) return null;
  let base: URL;
  try { base = new URL(baseUrl); } catch { return null; }
  if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username || base.password || base.search || base.hash) return null;
  if (base.port && !((base.protocol === "http:" && base.port === "80") || (base.protocol === "https:" && base.port === "443"))) return null;
  const host = base.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.includes(":") || /^\d+(?:\.\d+){3}$/.test(host)) return null;
  return base;
}

export function isSafeCloneParams(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 32 && entries.every(([key, item]) =>
    key.length > 0 && key.length <= 64 && typeof item === "string" && item.length <= 1024,
  );
}

export async function takeCloneProxyRateLimit(db: D1Database, username: string, now = Math.floor(Date.now() / 1000)): Promise<{ allowed: boolean; retryAfter: number }> {
  const windowStart = now - (now % PROXY_WINDOW_SECONDS);
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS clone_proxy_rate_limits (
      username TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (username, window_start)
    )`,
  ).run();
  const row = await db.prepare(
    `INSERT INTO clone_proxy_rate_limits (username, window_start, count)
     VALUES (?, ?, 1)
     ON CONFLICT(username, window_start) DO UPDATE SET count = count + 1
     RETURNING count`,
  ).bind(username, windowStart).first<{ count: number }>();
  const retryAfter = Math.max(1, windowStart + PROXY_WINDOW_SECONDS - now);
  return { allowed: (row?.count ?? CLONE_PROXY_RPM + 1) <= CLONE_PROXY_RPM, retryAfter };
}

export function limitedProxyBody(body: ReadableStream<Uint8Array>, maxBytes: number, onComplete: () => void): ReadableStream<Uint8Array> {
  return limitReadableStream(body, maxBytes, onComplete, onComplete);
}
