// SPDX-License-Identifier: AGPL-3.0-or-later

import { bodyLimit } from "hono/body-limit";
import { accountStorageAvailable, accountStatus, saveAccount, removeAccount } from "../../media/accounts";
import { embeddedVideoSession } from "../../media/references";
import { ktvSettings } from "../../media/settings";
import { Hono } from "hono";
import { permissionMiddleware } from "../../auth";
import type { User } from "../../types/entities";
import { MediaLoaderError, requestMedia, resolveExternalMedia } from "../../media/loader";
import { findMediaSession, forgetMediaSession, mediaArtifactResponse, rememberMediaSession } from "../../media/sessions";

export const videoMediaRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

videoMediaRoutes.use("/media/*", permissionMiddleware("stream"));
videoMediaRoutes.use("/media/*", bodyLimit({ maxSize: 98_304, onError: (c) => c.json({ ok: false, error: "Request is too large" }, 413) }));
videoMediaRoutes.use("/media/*", async (c, next) => {
  const origin = c.req.header("Origin");
  if (origin && origin !== new URL(c.req.url).origin) return c.json({ ok: false, error: "Origin is not allowed" }, 403);
  c.header("Cache-Control", "no-store");
  await next();
});
videoMediaRoutes.onError((error, c) => {
  const status = error instanceof MediaLoaderError ? error.status : 502;
  return new Response(JSON.stringify({ ok: false, error: error instanceof MediaLoaderError ? error.message : "Media is unavailable" }), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
});

videoMediaRoutes.post("/media/resolve", async (c) => {
  const user = c.get("user");
  if (user.level < 1) return c.json({ ok: false, error: "Sign in to prepare video" }, 403);
  const body = await c.req.json<{ url?: unknown; mode?: unknown }>().catch(() => null);
  if (typeof body?.url !== "string" || body.url.length > 2048) return c.json({ ok: false, error: "Invalid video reference" }, 400);
  if (!c.env.MediaContainer || body.mode === "compatible") {
    const settings = await ktvSettings(c.env, user.username);
    if (!settings.allowEmbeddedVideo) return c.json({ ok: false, error: "Enable embedded video in Tools first" }, 403);
    return c.json({ ok: true, session: await embeddedVideoSession(body.url) });
  }
  const session = await resolveExternalMedia(c.env, body.url.trim(), c.req.raw.signal, user.username);
  await rememberMediaSession(c.env, user.username, session);
  return c.json({ ok: true, session });
});

videoMediaRoutes.get("/media/accounts", async (c) => {
  const username = c.get("user").username;
  return c.json({ ok: true, available: accountStorageAvailable(c.env), accounts: await Promise.all([accountStatus(c.env, username, "youtube"), accountStatus(c.env, username, "bilibili")]) });
});
videoMediaRoutes.put("/media/accounts/:provider", async (c) => {
  if (c.get("user").level < 1) return c.body(null, 403);
  const provider = c.req.param("provider");
  if (provider !== "youtube" && provider !== "bilibili") return c.body(null, 404);
  const body = await c.req.json<{ cookies?: unknown }>().catch(() => null);
  if (typeof body?.cookies !== "string") return c.json({ ok: false, error: "Choose a cookies.txt file" }, 400);
  await saveAccount(c.env, c.get("user").username, provider, body.cookies);
  return c.json({ ok: true });
});
videoMediaRoutes.delete("/media/accounts/:provider", async (c) => {
  if (c.get("user").level < 1) return c.body(null, 403);
  const provider = c.req.param("provider");
  if (provider !== "youtube" && provider !== "bilibili") return c.body(null, 404);
  await removeAccount(c.env, c.get("user").username, provider);
  return c.json({ ok: true });
});
videoMediaRoutes.post("/media/accounts/bilibili/qr", async (c) => {
  if (c.get("user").level < 1) return c.body(null, 403);
  if (!accountStorageAvailable(c.env)) throw new MediaLoaderError("Platform authorization is unavailable", 503);
  const response = await requestMedia(c.env, "/media/auth/bilibili/qr", { method: "POST", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) { await response.body?.cancel(); throw new MediaLoaderError("Bilibili sign-in is unavailable"); }
  const data = await response.json<{ id: string; url: string; expiresAt: number }>();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(data.id) || !Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now() / 1000 || data.expiresAt > Date.now() / 1000 + 600) throw new MediaLoaderError("Invalid sign-in session");
  await c.env.DB.prepare("INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, unixepoch())").bind(`media_qr:${data.id}`, JSON.stringify({ username: c.get("user").username, expiresAt: data.expiresAt })).run();
  await c.env.DB.prepare("DELETE FROM kv_store WHERE key GLOB 'media_qr:*' AND updated_at < unixepoch() - 600").run();
  return c.json({ ok: true, ...data });
});
videoMediaRoutes.get("/media/accounts/bilibili/qr/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) return c.body(null, 404);
  const row = await c.env.DB.prepare("SELECT value FROM kv_store WHERE key = ?").bind(`media_qr:${id}`).first<{ value: string }>();
  const owner = row ? JSON.parse(row.value) as { username: string; expiresAt: number } : null;
  if (!owner || owner.username !== c.get("user").username) return c.body(null, 404);
  if (owner.expiresAt <= Date.now() / 1000) return c.json({ ok: true, status: "expired" });
  const response = await requestMedia(c.env, `/media/auth/bilibili/qr/${id}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) { await response.body?.cancel(); throw new MediaLoaderError("Bilibili sign-in status is unavailable"); }
  const data = await response.json<{ status: string; cookies?: string; profile?: { id?: string; displayName?: string } }>();
  if (data.status === "authorized" && data.cookies) {
    await saveAccount(c.env, owner.username, "bilibili", data.cookies, data.profile);
    await c.env.DB.prepare("DELETE FROM kv_store WHERE key = ?").bind(`media_qr:${id}`).run();
  }
  return c.json({ ok: true, status: data.status });
});

videoMediaRoutes.get("/media/:session/*", (c) => {
  const prefix = `/edgesonic/media/${c.req.param("session")}/`;
  const artifact = new URL(c.req.url).pathname.slice(prefix.length);
  return mediaArtifactResponse(c.env, c.get("user").username, c.req.param("session"), artifact, c.req.raw);
});

videoMediaRoutes.delete("/media/:session", async (c) => {
  const id = c.req.param("session");
  if (!await findMediaSession(c.env, c.get("user").username, id)) return c.body(null, 204);
  const response = await requestMedia(c.env, `/media/sessions/${id}`, { method: "DELETE", signal: c.req.raw.signal });
  await response.body?.cancel();
  if (!response.ok && response.status !== 404) throw new MediaLoaderError("Media session could not be released");
  await forgetMediaSession(c.env, id);
  return c.body(null, 204);
});
