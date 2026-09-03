// SPDX-License-Identifier: AGPL-3.0-or-later

import { createMiddleware } from "hono/factory";
import type { User } from "../types/entities";

export type RateLimiter = Pick<RateLimit, "limit">;

const RETRY_AFTER_SECONDS = 60;

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function authenticationRateLimitKey(request: Request, route: "login" | "register", username: string): string {
  return `${route}:${normalizeUsername(username)}:${clientIp(request)}`;
}

export async function rateLimitAllowed(limiter: RateLimiter | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  return (await limiter.limit({ key })).success;
}

export const apiRateLimitMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: { user: User };
}>(async (c, next) => {
  const user = c.get("user");
  if (!user) return next();
  if (!(await rateLimitAllowed(c.env.API_RATE_LIMITER, user.username))) {
    return c.json({ ok: false, error: "Too many requests" }, 429, {
      "Retry-After": String(RETRY_AFTER_SECONDS),
    });
  }
  return next();
});

export function rateLimitExceededResponse() {
  return new Response(JSON.stringify({ ok: false, error: "Too many requests" }), {
    status: 429,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Retry-After": String(RETRY_AFTER_SECONDS),
    },
  });
}
