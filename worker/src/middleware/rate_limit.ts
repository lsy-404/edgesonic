// SPDX-License-Identifier: AGPL-3.0-or-later

import { createMiddleware } from "hono/factory";
import type { User } from "../types/entities";

export type RateLimiter = Pick<RateLimit, "limit">;

const RETRY_AFTER_SECONDS = 60;
const DEVICE_ID_BYTES = 12;
const DEVICE_HEADER = "X-EdgeSonic-Device";
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function stableClientSignal(request: Request): string {
  const deviceId = request.headers.get(DEVICE_HEADER)?.trim();
  if (deviceId && DEVICE_ID_RE.test(deviceId)) return `first-party:${deviceId}`;

  const clientIp = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
  return [
    `third-party:${clientIp}`,
    request.headers.get("User-Agent") || "unknown",
    request.headers.get("Sec-CH-UA") || "",
    request.headers.get("Sec-CH-UA-Platform") || "",
  ].join("\n");
}

export async function rateLimitDeviceId(...parts: string[]): Promise<string> {
  const input = parts.map((part) => `${part.length}:${part}`).join("|");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
  return Array.from(digest.slice(0, DEVICE_ID_BYTES), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function authenticationRateLimitKey(
  request: Request,
  route: "login" | "register",
  username: string,
): Promise<string> {
  const normalizedUsername = normalizeUsername(username);
  const deviceId = await rateLimitDeviceId("anonymous-auth", stableClientSignal(request));
  return `auth:${route}:${normalizedUsername}:${deviceId}`;
}

export function authenticatedRateLimitKey(username: string, deviceId: string): string {
  return `api:${normalizeUsername(username)}:${deviceId}`;
}

export async function rateLimitAllowed(limiter: RateLimiter | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  return (await limiter.limit({ key })).success;
}

export const apiRateLimitMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: { user: User; rateLimitDeviceId?: string };
}>(async (c, next) => {
  const user = c.get("user");
  if (!user) return next();
  const deviceId = c.get("rateLimitDeviceId");
  if (!deviceId) {
    return c.json({ ok: false, error: "Rate limit identity unavailable" }, 500);
  }
  if (!(await rateLimitAllowed(c.env.API_RATE_LIMITER, authenticatedRateLimitKey(user.username, deviceId)))) {
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
