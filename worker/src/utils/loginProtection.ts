const WINDOW_SECONDS = 60;
const MAX_FAILURES = 5;

function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") || req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
}

function keyFor(req: Request, username: string): string {
  return `${clientIp(req)}\n${username.trim().toLowerCase()}`;
}

async function ensureTable(db: D1Database): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS login_rate_limits (
    key TEXT PRIMARY KEY, window_started INTEGER NOT NULL, failures INTEGER NOT NULL, blocked_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
  )`).run();
}

export async function loginAllowed(db: D1Database, req: Request, username: string): Promise<number> {
  await ensureTable(db);
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare("SELECT blocked_until FROM login_rate_limits WHERE key = ?").bind(keyFor(req, username)).first<{ blocked_until: number }>();
  return row && row.blocked_until > now ? row.blocked_until - now : 0;
}

export async function recordLoginFailure(db: D1Database, req: Request, username: string): Promise<number> {
  await ensureTable(db);
  const now = Math.floor(Date.now() / 1000);
  const key = keyFor(req, username);
  const row = await db.prepare(`INSERT INTO login_rate_limits (key, window_started, failures, blocked_until, updated_at)
    VALUES (?, ?, 1, 0, ?)
    ON CONFLICT(key) DO UPDATE SET
      window_started = CASE WHEN login_rate_limits.window_started <= excluded.updated_at - ? THEN excluded.window_started ELSE login_rate_limits.window_started END,
      failures = CASE WHEN login_rate_limits.window_started <= excluded.updated_at - ? THEN 1 ELSE login_rate_limits.failures + 1 END,
      blocked_until = CASE
        WHEN login_rate_limits.window_started <= excluded.updated_at - ? THEN 0
        WHEN login_rate_limits.failures + 1 >= ? THEN excluded.updated_at + ?
        ELSE 0
      END,
      updated_at = excluded.updated_at
    RETURNING blocked_until`)
    .bind(key, now, now, WINDOW_SECONDS, WINDOW_SECONDS, WINDOW_SECONDS, MAX_FAILURES, WINDOW_SECONDS)
    .first<{ blocked_until: number }>();
  return (row?.blocked_until ?? 0) > now ? (row!.blocked_until - now) : 0;
}

export async function clearLoginFailures(db: D1Database, req: Request, username: string): Promise<void> {
  await ensureTable(db);
  await db.prepare("DELETE FROM login_rate_limits WHERE key = ?").bind(keyFor(req, username)).run();
}

export async function verifyTurnstile(env: Env, req: Request, token: unknown, action: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET || !env.TURNSTILE_SITE_KEY) return true;
  if (typeof token !== "string" || !token) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: clientIp(req) });
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body, signal: controller.signal });
    const result = await response.json() as { success?: boolean; action?: string; hostname?: string };
    if (!result.success || (result.action !== undefined && result.action !== action)) return false;
    if (result.hostname !== undefined && result.hostname !== new URL(req.url).hostname) return false;
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
