// SPDX-License-Identifier: AGPL-3.0-or-later

import { Hono } from "hono";
import { permissionMiddleware } from "../../auth";
import { hasPermission } from "../../utils/permissions";
import { embeddedVideoSession } from "../../media/references";
import { ktvSettings } from "../../media/settings";
import { MediaLoaderError } from "../../media/loader";
import {
  getVideo, importStorageVideo, listVideos, prepareVideoMedia, saveExternalVideo, videoSummary, rawVideoResponse,
} from "../../media/videos";
import type { User } from "../../types/entities";

export const videoRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

function errorResponse(error: unknown): Response {
  const status = error instanceof MediaLoaderError ? error.status
    : error instanceof Error && /invalid|supported|storage file|source/i.test(error.message) ? 400 : 502;
  return Response.json({ ok: false, error: error instanceof Error ? error.message : "Video request failed" }, { status });
}

videoRoutes.get("/videos", permissionMiddleware("browse"), async (c) => {
  const offset = Math.max(0, Number.parseInt(c.req.query("offset") || "0", 10) || 0);
  const limit = Math.min(100, Math.max(1, Number.parseInt(c.req.query("limit") || "50", 10) || 50));
  const { videos, total } = await listVideos(c.env, c.req.query("query") || "", offset, limit);
  return c.json({ ok: true, videos, total });
});

videoRoutes.post("/videos/external", permissionMiddleware("upload"), async (c) => {
  const body = await c.req.json<{ url?: string }>().catch(() => null);
  if (!body || typeof body.url !== "string" || !body.url.trim()) {
    return c.json({ ok: false, error: "Missing video URL" }, 400);
  }
  try {
    const video = await saveExternalVideo(c.env, body.url.trim(), c.req.raw.signal, c.get("user").username);
    return c.json({ ok: true, video: videoSummary(video) });
  } catch (error) {
    return errorResponse(error);
  }
});

videoRoutes.post("/videos/import", permissionMiddleware("upload"), async (c) => {
  const body = await c.req.json<{ sourceId?: string; path?: string }>().catch(() => null);
  if (!body || typeof body.sourceId !== "string" || typeof body.path !== "string") {
    return c.json({ ok: false, error: "Missing sourceId or path" }, 400);
  }
  try {
    const video = await importStorageVideo(c.env, body.sourceId, body.path);
    return c.json({ ok: true, video: videoSummary(video) });
  } catch (error) {
    return errorResponse(error);
  }
});

videoRoutes.get("/videos/links", permissionMiddleware("browse"), async (c) => {
  const audioId = c.req.query("audioId");
  const videoId = c.req.query("videoId");
  if (!!audioId === !!videoId) return c.json({ ok: false, error: "Provide exactly one of audioId or videoId" }, 400);
  const filter = audioId ? "l.audio_id = ?" : "l.video_id = ?";
  const rows = await c.env.DB.prepare(
    `SELECT l.audio_id, l.video_id, sm.title AS audio_title, v.title AS video_title, l.offset_ms
       FROM video_audio_links l JOIN song_masters sm ON sm.id = l.audio_id
       JOIN videos v ON v.id = l.video_id
      WHERE ${filter} AND v.missing = 0 AND (v.provider != 'file' OR EXISTS (
        SELECT 1 FROM storage_sources ss WHERE ss.id = v.source_id AND ss.enabled = 1
      )) ORDER BY lower(v.title), lower(sm.title)`,
  ).bind(audioId || videoId).all<{
    audio_id: string; video_id: string; audio_title: string; video_title: string; offset_ms: number;
  }>();
  return c.json({ ok: true, links: rows.results.map((row) => ({
    audioId: row.audio_id, videoId: row.video_id, audioTitle: row.audio_title,
    videoTitle: row.video_title, offsetMs: row.offset_ms,
  })) });
});

videoRoutes.put("/videos/:videoId/links/:audioId", async (c) => {
  const user = c.get("user");
  if (!(await hasPermission(c.env, user, "edit_tags"))) return c.json({ ok: false, error: "Not authorized" }, 403);
  const body = await c.req.json<{ offsetMs?: number }>().catch(() => null);
  if (!body || !Number.isSafeInteger(body.offsetMs)) return c.json({ ok: false, error: "offsetMs must be an integer" }, 400);
  const video = await getVideo(c.env, c.req.param("videoId"));
  const audio = await c.env.DB.prepare("SELECT id FROM song_masters WHERE id = ?")
    .bind(c.req.param("audioId")).first<{ id: string }>();
  if (!video || !audio) return c.json({ ok: false, error: "Video or audio item not found" }, 404);
  await c.env.DB.prepare(
    `INSERT INTO video_audio_links (video_id, audio_id, offset_ms, created_at, updated_at)
     VALUES (?, ?, ?, unixepoch(), unixepoch())
     ON CONFLICT(video_id, audio_id) DO UPDATE SET offset_ms = excluded.offset_ms, updated_at = excluded.updated_at`,
  ).bind(video.id, audio.id, body.offsetMs).run();
  return c.json({ ok: true });
});

videoRoutes.delete("/videos/:videoId/links/:audioId", async (c) => {
  const user = c.get("user");
  if (!(await hasPermission(c.env, user, "edit_tags"))) return c.json({ ok: false, error: "Not authorized" }, 403);
  await c.env.DB.prepare("DELETE FROM video_audio_links WHERE video_id = ? AND audio_id = ?")
    .bind(c.req.param("videoId"), c.req.param("audioId")).run();
  return c.json({ ok: true });
});

videoRoutes.get("/videos/:id/playback", permissionMiddleware("stream"), async (c) => {
  const video = await getVideo(c.env, c.req.param("id"));
  if (!video) return c.json({ ok: false, error: "Video not found" }, 404);
  try {
    if (!c.env.MediaContainer || c.req.query("mode") === "compatible") {
      if (video.provider === "file") return c.json({ ok: true, session: { id: crypto.randomUUID(), transport: "file", sourceUrl: `/edgesonic/videos/${video.id}/stream`, title: video.title, duration: video.duration, width: video.width, height: video.height, expiresAt: Math.floor(Date.now() / 1000) + 43_200, audioTracks: [{ id: "default" }], captions: [] } });
      const settings = await ktvSettings(c.env, c.get("user").username);
      if (!settings.allowEmbeddedVideo) return c.json({ ok: false, error: "Enable embedded video in Tools first" }, 403);
      return c.json({ ok: true, session: { ...await embeddedVideoSession(video.externalUrl!), title: video.title } });
    }
    const session = await prepareVideoMedia(c.env, video, c.get("user").username, c.req.raw.signal, false);
    return c.json({ ok: true, session });
  } catch (error) {
    return errorResponse(error);
  }
});

videoRoutes.get("/videos/:id/stream", permissionMiddleware("stream"), async (c) => {
  const video = await getVideo(c.env, c.req.param("id"));
  if (!video) return c.body(null, 404);
  return rawVideoResponse(c.env, video, c.req.raw);
});
