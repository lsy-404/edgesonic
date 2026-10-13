// SPDX-License-Identifier: AGPL-3.0-or-later

import { Hono } from "hono";
import { permissionMiddleware } from "../../auth";
import type { User } from "../../types/entities";
import { MediaLoaderError, requestMedia, resolveExternalMedia } from "../../media/loader";
import { findMediaSession, forgetMediaSession, mediaArtifactResponse, rememberMediaSession } from "../../media/sessions";

export const videoMediaRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

videoMediaRoutes.use("/media/*", permissionMiddleware("stream"));
videoMediaRoutes.onError((error, c) => {
  const status = error instanceof MediaLoaderError ? error.status : 502;
  return new Response(JSON.stringify({ ok: false, error: error instanceof MediaLoaderError ? error.message : "Media is unavailable" }), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
});

videoMediaRoutes.post("/media/resolve", async (c) => {
  const user = c.get("user");
  if (user.level < 1) return c.json({ ok: false, error: "Sign in to prepare video" }, 403);
  const body = await c.req.json<{ url?: unknown }>().catch(() => null);
  if (typeof body?.url !== "string" || body.url.length > 2048) return c.json({ ok: false, error: "Invalid video reference" }, 400);
  const session = await resolveExternalMedia(c.env, body.url.trim(), c.req.raw.signal);
  await rememberMediaSession(c.env, user.username, session);
  return c.json({ ok: true, session });
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
