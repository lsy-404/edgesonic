// SPDX-License-Identifier: AGPL-3.0-or-later

import { Hono } from "hono";
import type { Context } from "hono";
import { hasPermission } from "../../utils/permissions";
import { subsonicError } from "../../auth";
import { subsonicOK } from "../../utils/xml";
import { findMediaSession, mediaArtifactResponse } from "../../media/sessions";
import { getVideo, listVideos, prepareVideoMedia, rawVideoResponse } from "../../media/videos";
import type { Video, VideoSummary } from "../../media/videos";
import type { User } from "../../types/entities";

export const videoSubsonicRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;
const attrs = (value: object) => ({ _attributes: value as Record<string, string | number | boolean | undefined> });

function register(path: string, handler: (c: Context, next: () => Promise<void>) => Promise<Response | void>) {
  for (const candidate of [`/${path}`, `/${path}.view`]) {
    videoSubsonicRoutes.on(["GET", "POST"], candidate, handler);
  }
}

function videoChild(video: Video | VideoSummary) {
  return attrs({
    id: video.id,
    isDir: false,
    title: video.title,
    duration: video.duration ?? undefined,
    size: video.size ?? undefined,
    contentType: video.contentType ?? undefined,
    suffix: video.suffix ?? undefined,
    isVideo: true,
    type: "video",
    originalWidth: video.width ?? undefined,
  });
}

async function lookupVideo(c: Context): Promise<{ matches: boolean; video?: Video }> {
  const id = c.req.query("id");
  if (!id?.startsWith("vi-")) return { matches: false };
  const video = await getVideo(c.env as Env, id);
  return { matches: true, video: video || undefined };
}

function videoNotFound(c: Context): Response {
  return c.text(subsonicError(70, "Video not found"), 404, XML);
}

async function requirePermission(c: Context, permission: "browse" | "stream" | "download"): Promise<Response | null> {
  const user = c.get("user") as User | undefined;
  if (user && await hasPermission(c.env as Env, user, permission)) return null;
  return c.text(subsonicError(50, "Not authorized for this operation"), 403, XML);
}

function mapAssetRequest(request: Request, videoId: string, sessionId: string) {
  const original = new URL(request.url);
  const auth = new URLSearchParams();
  for (const key of ["u", "p", "t", "s", "apiKey", "v", "c", "f"]) {
    for (const value of original.searchParams.getAll(key)) auth.append(key, value);
  }
  return (artifact: string) => {
    const query = new URLSearchParams(auth);
    query.set("id", videoId);
    query.set("session", sessionId);
    query.set("path", artifact);
    return `/rest/videoAsset.view?${query}`;
  };
}

register("getVideos", async (c) => {
  const denied = await requirePermission(c, "browse");
  if (denied) return denied;
  const result = await listVideos(c.env as Env, "", 0, 10000);
  return c.text(subsonicOK({ videos: { video: result.videos.map(videoChild) } }), 200, XML);
});

register("getVideoInfo", async (c, next) => {
  if (!c.req.query("id")) return c.text(subsonicError(10, "Missing id parameter"), 400, XML);
  const match = await lookupVideo(c);
  if (!match.matches) return next();
  const denied = await requirePermission(c, "browse");
  if (denied) return denied;
  const id = c.req.query("id");
  if (!id) return c.text(subsonicError(10, "Missing id parameter"), 400, XML);
  const video = match.video;
  if (!video) return videoNotFound(c);
  try {
    const session = await prepareVideoMedia(c.env as Env, video, c.get("user").username, c.req.raw.signal);
    return c.text(subsonicOK({
      videoInfo: {
        _attributes: { id: video.id },
        captions: session.captions.map((track) => ({ _attributes: {
          id: track.id, name: track.title || track.language,
        } })),
        audioTrack: session.audioTracks.map((track) => ({ _attributes: {
          id: track.id, name: track.title || track.language, languageCode: track.language,
        } })),
      },
    }), 200, XML);
  } catch {
    return c.text(subsonicError(70, "Video information is unavailable"), 404, XML);
  }
});

register("getSong", async (c, next) => {
  const match = await lookupVideo(c);
  if (!match.matches) return next();
  if (!match.video) return videoNotFound(c);
  const denied = await requirePermission(c, "browse");
  if (denied) return denied;
  return c.text(subsonicOK({ song: videoChild(match.video) }), 200, XML);
});

register("stream", async (c, next) => {
  const match = await lookupVideo(c);
  if (!match.matches) return next();
  if (!match.video) return videoNotFound(c);
  const result = match.video;
  const denied = await requirePermission(c, "stream");
  if (denied) return denied;
  const format = (c.req.query("format") || "").toLowerCase();
  if (format === "raw" && result.provider === "file") return rawVideoResponse(c.env as Env, result, c.req.raw);
  const username = c.get("user").username;
  try {
    const session = await prepareVideoMedia(c.env as Env, result, username, c.req.raw.signal);
    return mediaArtifactResponse(c.env as Env, username, session.id, "stream", c.req.raw);
  } catch {
    return c.text(subsonicError(70, "Video stream is unavailable"), 404, XML);
  }
});

register("download", async (c, next) => {
  const match = await lookupVideo(c);
  if (!match.matches) return next();
  if (!match.video) return videoNotFound(c);
  const denied = await requirePermission(c, "download");
  if (denied) return denied;
  if (match.video.provider === "file") return rawVideoResponse(c.env as Env, match.video, c.req.raw, true);
  try {
    const username = c.get("user").username;
    const session = await prepareVideoMedia(c.env as Env, match.video, username, c.req.raw.signal);
    const response = await mediaArtifactResponse(c.env as Env, username, session.id, "stream", c.req.raw);
    const headers = new Headers(response.headers);
    headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${match.video.title}.${match.video.suffix || "mp4"}`)}`);
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return c.text(subsonicError(70, "Video download is unavailable"), 404, XML);
  }
});

register("hls", async (c, next) => {
  const match = await lookupVideo(c);
  if (!match.matches) return next();
  if (!match.video) return videoNotFound(c);
  const result = match.video;
  const denied = await requirePermission(c, "stream");
  if (denied) return denied;
  const username = c.get("user").username;
  try {
    const session = await prepareVideoMedia(c.env as Env, result, username, c.req.raw.signal);
    return mediaArtifactResponse(c.env as Env, username, session.id, "hls.m3u8", c.req.raw,
      mapAssetRequest(c.req.raw, result.id, session.id));
  } catch {
    return c.text(subsonicError(70, "Video playlist is unavailable"), 404, XML);
  }
});

register("videoAsset", async (c) => {
  const denied = await requirePermission(c, "stream");
  if (denied) return denied;
  const sessionId = c.req.query("session");
  const videoId = c.req.query("id");
  const artifact = c.req.query("path");
  const username = c.get("user").username;
  if (!sessionId || !videoId || !videoId.startsWith("vi-") || !artifact) return c.notFound();
  const video = await getVideo(c.env as Env, videoId);
  const session = await findMediaSession(c.env as Env, username, sessionId);
  if (!video || !session) return c.text(subsonicError(70, "Video session expired"), 404, XML);
  return mediaArtifactResponse(c.env as Env, username, sessionId, artifact, c.req.raw,
    mapAssetRequest(c.req.raw, videoId, sessionId));
});

register("getCaptions", async (c, next) => {
  const match = await lookupVideo(c);
  if (!match.matches) return next();
  if (!match.video) return videoNotFound(c);
  const result = match.video;
  const denied = await requirePermission(c, "stream");
  if (denied) return denied;
  const format = c.req.query("format");
  if (format && format !== "srt" && format !== "vtt") return c.text(subsonicError(0, "Unsupported caption format"), 400, XML);
  const requestedTrack = c.req.query("track");
  const username = c.get("user").username;
  try {
    const session = await prepareVideoMedia(c.env as Env, result, username, c.req.raw.signal);
    if (requestedTrack && !session.captions.some((track) => track.id === requestedTrack)) {
      return c.text(subsonicError(70, "Caption track not found"), 404, XML);
    }
    return mediaArtifactResponse(c.env as Env, username, session.id, "captions", c.req.raw);
  } catch {
    return c.text(subsonicError(70, "Captions are unavailable"), 404, XML);
  }
});

register("getCoverArt", async (c, next) => {
  const match = await lookupVideo(c);
  if (!match.matches) return next();
  if (!match.video) return videoNotFound(c);
  return c.body(null, 404);
});
