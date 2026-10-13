// SPDX-License-Identifier: AGPL-3.0-or-later

import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { User } from "../types/entities";
import { hasPermission } from "../utils/permissions";
import { ktvSettings as settings } from "../media/settings";
import { rateLimitAllowed } from "../middleware/rate_limit";

type RoomContext = Context<{ Bindings: Env; Variables: { user: User } }>;
export const ktvHostRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();
export const ktvPublicRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const smallBody = bodyLimit({ maxSize: 8192, onError: (c) => c.json({ ok: false, error: "Request is too large" }, 413) });
ktvHostRoutes.use("*", smallBody);
ktvPublicRoutes.use("*", smallBody);

for (const router of [ktvHostRoutes, ktvPublicRoutes]) {
  router.use("*", async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin && origin !== new URL(c.req.url).origin) return c.json({ ok: false, error: "Origin is not allowed" }, 403);
    c.header("Cache-Control", "no-store");
    await next();
  });
}

ktvHostRoutes.use("*", async (c, next) => {
  const user = c.get("user");
  if (!user || user.level < 1 || !await hasPermission(c.env, user, "stream")) return c.json({ ok: false, error: "Sign in with playback permission" }, 403);
  await next();
});

ktvPublicRoutes.use("*", async (c, next) => {
  const key = `ktv:${c.req.header("CF-Connecting-IP") || "local"}`;
  if (!await rateLimitAllowed(c.env.API_RATE_LIMITER, key)) return c.json({ ok: false, error: "Please try again later" }, 429);
  await next();
});

ktvHostRoutes.get("/settings", async (c) => c.json({ ok: true, ...await settings(c.env, c.get("user").username) }));
ktvHostRoutes.put("/settings", async (c) => {
  const body = await c.req.json<{ enabled?: unknown; mode?: unknown; mediaMode?: unknown; allowEmbeddedVideo?: unknown }>().catch(() => null);
  if (!body || (body.enabled !== undefined && typeof body.enabled !== "boolean") || (body.mediaMode !== undefined && !["full", "compatible"].includes(String(body.mediaMode))) || (body.allowEmbeddedVideo !== undefined && typeof body.allowEmbeddedVideo !== "boolean") || (body.mode !== undefined && body.mode !== "fair" && body.mode !== "fifo")) return c.json({ ok: false, error: "Invalid KTV settings" }, 400);
  const username = c.get("user").username;
  const updates: D1PreparedStatement[] = [];
  for (const [key, value] of [["ktv_enabled", body.enabled === undefined ? undefined : body.enabled ? "1" : "0"], ["ktv_queue_mode", body.mode], ["ktv_media_mode", body.mediaMode], ["ktv_allow_embedded_video", body.allowEmbeddedVideo === undefined ? undefined : body.allowEmbeddedVideo ? "1" : "0"]] as const) {
    if (value !== undefined) updates.push(c.env.DB.prepare("INSERT INTO user_settings (username, key, value, updated_at) VALUES (?, ?, ?, unixepoch()) ON CONFLICT(username, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(username, key, value));
  }
  if (updates.length) await c.env.DB.batch(updates);
  if (body.enabled === false && c.env.KTV_ROOMS) {
    const prefix = `ktv_room:${username}:`;
    const rows = await c.env.DB.prepare("SELECT value FROM kv_store WHERE substr(key, 1, ?) = ?").bind(prefix.length, prefix).all<{ value: string }>();
    await Promise.all(rows.results.map(async (row) => {
      if (!/^[a-f0-9]{64}$/.test(row.value)) return;
      const stub = c.env.KTV_ROOMS.get(c.env.KTV_ROOMS.idFromString(row.value));
      await stub.fetch("https://ktv.invalid/disable", { method: "POST", headers: { "X-KTV-Owner": username } });
    }));
    await c.env.DB.prepare("DELETE FROM kv_store WHERE substr(key, 1, ?) = ?").bind(prefix.length, prefix).run();
  }
  return c.json({ ok: true, ...await settings(c.env, username) });
});

ktvHostRoutes.post("/rooms", async (c) => {
  if (!c.env.KTV_ROOMS) return c.json({ ok: false, error: "KTV rooms are not configured" }, 503);
  const user = c.get("user");
  const config = await settings(c.env, user.username);
  if (!config.enabled) return c.json({ ok: false, error: "Enable KTV mode first" }, 403);
  if (!await hasPermission(c.env, user, "browse") || !await hasPermission(c.env, user, "search")) return c.json({ ok: false, error: "Library access is required" }, 403);
  const body = await c.req.json<{ playerId?: unknown; mode?: unknown; displayName?: unknown }>().catch(() => null);
  if (!body || typeof body.playerId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(body.playerId)) return c.json({ ok: false, error: "Invalid playback instance" }, 400);
  if (body.mode !== undefined && body.mode !== "fair" && body.mode !== "fifo") return c.json({ ok: false, error: "Invalid queue mode" }, 400);
  const id = c.env.KTV_ROOMS.idFromName(`${c.env.INSTANCE_ID}:${user.username}:${body.playerId}`);
  const response = await c.env.KTV_ROOMS.get(id).fetch("https://ktv.invalid/create", {
    method: "POST", headers: { "Content-Type": "application/json", "X-KTV-Owner": user.username, "X-KTV-Origin": new URL(c.req.url).origin },
    body: JSON.stringify({ ...body, mode: body.mode ?? config.mode, mediaMode: config.mediaMode, allowEmbeddedVideo: config.allowEmbeddedVideo }),
  });
  if (response.ok) await c.env.DB.prepare("INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(`ktv_room:${user.username}:${body.playerId}`, id.toString()).run();
  return response;
});

async function forward(c: RoomContext, operation: string, host: boolean): Promise<Response> {
  if (!c.env.KTV_ROOMS) return c.json({ ok: false, error: "Room is unavailable" }, 404);
  const roomId = c.req.param("id") || "";
  if (!/^[a-f0-9]{64}$/.test(roomId)) return c.json({ ok: false, error: "Room is unavailable" }, 404);
  const original = new URL(c.req.url);
  const query = new URLSearchParams(original.search);
  const headers = new Headers({ "Content-Type": "application/json" });
  if (host) {
    headers.set("X-KTV-Owner", c.get("user").username);
    headers.set("X-KTV-Controller", c.req.header("X-KTV-Controller") || query.get("controller") || "");
  } else headers.set("Authorization", c.req.header("Authorization") || (query.has("participant") ? `Bearer ${query.get("participant")}` : ""));
  if (c.req.header("Upgrade")) headers.set("Upgrade", "websocket");
  query.delete("controller");
  query.delete("participant");
  const body = c.req.method === "GET" || c.req.method === "HEAD" ? undefined : await c.req.text();
  return c.env.KTV_ROOMS.get(c.env.KTV_ROOMS.idFromString(roomId)).fetch(`https://ktv.invalid/${operation}${query.size ? `?${query}` : ""}`, {
    method: c.req.method, headers, body,
  });
}

ktvHostRoutes.get("/rooms/:id", (c) => forward(c, "state", true));
ktvHostRoutes.get("/rooms/:id/ws", (c) => forward(c, "ws", true));
ktvHostRoutes.get("/rooms/:id/search", (c) => forward(c, "search", true));
ktvHostRoutes.get("/rooms/:id/links", (c) => forward(c, "links", true));
ktvHostRoutes.post("/rooms/:id/actions", (c) => forward(c, "actions", true));

ktvPublicRoutes.get("/rooms/:id", (c) => forward(c, "preview", false));
ktvPublicRoutes.post("/rooms/:id/join", (c) => forward(c, "join", false));
ktvPublicRoutes.get("/rooms/:id/state", (c) => forward(c, "state", false));
ktvPublicRoutes.get("/rooms/:id/ws", (c) => forward(c, "ws", false));
ktvPublicRoutes.get("/rooms/:id/search", (c) => forward(c, "search", false));
ktvPublicRoutes.get("/rooms/:id/links", (c) => forward(c, "links", false));
ktvPublicRoutes.post("/rooms/:id/actions", (c) => forward(c, "actions", false));

ktvPublicRoutes.get("/invites/:code", async (c) => {
  const code = c.req.param("code");
  if (!c.env.KTV_ROOMS || !/^[0-9]{6}$/.test(code)) return c.json({ ok: false, error: "Room is unavailable" }, 404);
  const row = await c.env.DB.prepare("SELECT value FROM kv_store WHERE key = ?").bind(`ktv_invite:${code}`).first<{ value: string }>();
  if (!row) return c.json({ ok: false, error: "Room is unavailable" }, 404);
  const invite = JSON.parse(row.value) as { roomId: string; expiresAt: number };
  if (invite.expiresAt <= Date.now() || !/^[a-f0-9]{64}$/.test(invite.roomId)) return c.json({ ok: false, error: "Room is closed" }, 410);
  return c.env.KTV_ROOMS.get(c.env.KTV_ROOMS.idFromString(invite.roomId)).fetch(`https://ktv.invalid/preview?invite=${code}`);
});
