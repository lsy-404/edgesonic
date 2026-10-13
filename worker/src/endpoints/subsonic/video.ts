// SPDX-License-Identifier: AGPL-3.0-or-later

import { Hono } from "hono";
import type { Context } from "hono";
import { hasPermission } from "../../utils/permissions";
import { subsonicError } from "../../auth";
import { subsonicOK } from "../../utils/xml";
import { mediaArtifactResponse } from "../../media/sessions";
import { MediaLoaderError } from "../../media/loader";
import {
  getVideo, invalidateVideoSession, listVideos, prepareVideoMedia, rawVideoResponse,
  videoSessionMatches,
} from "../../media/videos";
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
    originalHeight: video.height ?? undefined,
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
  for (const key of ["u", "p", "t", "s", "apiKey", "guestToken", "v", "c", "f"]) {
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

function videoError(c: Context, error: unknown, unavailable: string): Response {
  if (error instanceof MediaLoaderError && (error.status === 404 || error.status === 410)) {
    return c.text(subsonicError(70, unavailable), error.status, XML);
  }
  const status = error instanceof MediaLoaderError ? error.status : 502;
  const message = error instanceof MediaLoaderError ? error.message : unavailable;
  return new Response(subsonicError(0, message), { status, headers: XML });
}

function requestWithServiceBitRate(request: Request, rawMaxBitRate: string | null, removeFormat: boolean): Request {
  const url = new URL(request.url);
  if (rawMaxBitRate !== null) {
    url.searchParams.set("bitRate", rawMaxBitRate);
  }
  url.searchParams.delete("maxBitRate");
  if (removeFormat) url.searchParams.delete("format");
  return new Request(url, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers: request.headers,
    signal: request.signal,
  });
}

function requestWithoutQuery(request: Request, names: string[]): Request {
  const url = new URL(request.url);
  for (const name of names) url.searchParams.delete(name);
  return new Request(url, { method: "GET", headers: request.headers, signal: request.signal });
}

function validVideoSize(value: string | null): boolean {
  if (value === null) return true;
  const match = /^(\d{1,5})x(\d{1,5})$/.exec(value);
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width >= 1 && height >= 1 && width <= 8192 && height <= 8192;
}

function validBitRate(value: string): boolean {
  const match = /^(\d{1,6})(?:@(\d{1,5})x(\d{1,5}))?$/.exec(value);
  if (!match || Number(match[1]) > 100_000) return false;
  if (!match[2]) return true;
  return Number(match[2]) >= 1 && Number(match[2]) <= 8192
    && Number(match[3]) >= 1 && Number(match[3]) <= 8192;
}

function validAudioTrack(session: { audioTracks: Array<{ id: string }> }, track: string | null): boolean {
  return track === null || (track.length <= 128 && session.audioTracks.some((entry) => entry.id === track));
}

async function artifactWithRefresh(
  env: Env,
  username: string,
  video: Video,
  artifact: string,
  request: Request,
  mapAsset?: (sessionId: string) => (asset: string) => string,
): Promise<Response> {
  let session = await prepareVideoMedia(env, video, username, request.signal);
  try {
    return await mediaArtifactResponse(env, username, session.id, artifact, request, mapAsset?.(session.id));
  } catch (error) {
    if (!(error instanceof MediaLoaderError) || (error.status !== 404 && error.status !== 410)) throw error;
    await invalidateVideoSession(env, username, video, session.id);
    session = await prepareVideoMedia(env, video, username, request.signal);
    return mediaArtifactResponse(env, username, session.id, artifact, request, mapAsset?.(session.id));
  }
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
  } catch (error) {
    return videoError(c, error, "Video information is unavailable");
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
  const username = c.get("user").username;
  const maxBitRate = c.req.query("maxBitRate") ?? null;
  const maxBitRateNumber = maxBitRate === null ? 0 : Number(maxBitRate);
  const offsetRaw = c.req.query("timeOffset") ?? null;
  const timeOffset = offsetRaw === null ? 0 : Number(offsetRaw);
  const size = c.req.query("size") ?? null;
  const audioTrack = c.req.query("audioTrack") ?? null;
  if (maxBitRate !== null && (!/^\d+$/.test(maxBitRate) || !Number.isSafeInteger(maxBitRateNumber)
    || maxBitRateNumber < 0 || maxBitRateNumber > 100_000)) {
    return c.text(subsonicError(0, "Invalid maxBitRate"), 400, XML);
  }
  if (offsetRaw !== null && (!/^\d+(?:\.\d+)?$/.test(offsetRaw) || !Number.isFinite(timeOffset)
    || timeOffset < 0 || timeOffset > 86_400)) {
    return c.text(subsonicError(0, "Invalid timeOffset"), 400, XML);
  }
  if (!validVideoSize(size) || (audioTrack !== null && (!audioTrack || audioTrack.length > 128))) {
    return c.text(subsonicError(0, "Invalid video playback options"), 400, XML);
  }
  if (format && !["raw", "mp4", "mp3", "m4a", "opus", "auto"].includes(format)) {
    return c.text(subsonicError(0, "Unsupported video format"), 400, XML);
  }
  const hasOptions = maxBitRateNumber > 0 || timeOffset > 0 || size !== null || audioTrack !== null;
  if (format === "raw") {
    if (hasOptions) return c.text(subsonicError(0, "raw cannot be combined with video conversions"), 400, XML);
    if (result.provider !== "file") return c.text(subsonicError(0, "Raw external video is unavailable"), 501, XML);
    return rawVideoResponse(c.env as Env, result, c.req.raw);
  }
  if ((!format || format === "auto") && !hasOptions && result.provider === "file") {
    return rawVideoResponse(c.env as Env, result, c.req.raw);
  }
  try {
    const session = await prepareVideoMedia(c.env as Env, result, username, c.req.raw.signal);
    if (!validAudioTrack(session, audioTrack)) return c.text(subsonicError(70, "Audio track not found"), 404, XML);
    const proxyRequest = requestWithServiceBitRate(c.req.raw, maxBitRate, !format || format === "auto" || format === "mp4");
    return await artifactWithRefresh(c.env as Env, username, result, "stream", proxyRequest);
  } catch (error) {
    return videoError(c, error, "Video stream is unavailable");
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
  } catch (error) {
    return videoError(c, error, "Video download is unavailable");
  }
});

register("hls.m3u8", async (c, next) => {
  const match = await lookupVideo(c);
  if (!match.matches) return next();
  if (!match.video) return videoNotFound(c);
  const result = match.video;
  const denied = await requirePermission(c, "stream");
  if (denied) return denied;
  const username = c.get("user").username;
  const requestUrl = new URL(c.req.url);
  const bitRates = requestUrl.searchParams.getAll("bitRate");
  if (bitRates.some((rate) => !validBitRate(rate)) || bitRates.length > 16) {
    return c.text(subsonicError(0, "Invalid HLS bitRate"), 400, XML);
  }
  const audioOnly = requestUrl.searchParams.get("audioOnly");
  if (audioOnly !== null && audioOnly !== "0" && audioOnly !== "1") {
    return c.text(subsonicError(0, "Invalid audioOnly value"), 400, XML);
  }
  const audioTrack = requestUrl.searchParams.get("audioTrack");
  if (requestUrl.searchParams.has("maxBitRate") || requestUrl.searchParams.has("timeOffset")
    || requestUrl.searchParams.has("size") || requestUrl.searchParams.has("format")) {
    return c.text(subsonicError(0, "Unsupported HLS playback options"), 400, XML);
  }
  try {
    const session = await prepareVideoMedia(c.env as Env, result, username, c.req.raw.signal);
    if (!validAudioTrack(session, audioTrack)) return c.text(subsonicError(70, "Audio track not found"), 404, XML);
    const hlsRequest = requestWithoutQuery(c.req.raw, ["format"]);
    return await artifactWithRefresh(c.env as Env, username, result, "hls.m3u8", hlsRequest,
      (sessionId) => mapAssetRequest(c.req.raw, result.id, sessionId));
  } catch (error) {
    return videoError(c, error, "Video playlist is unavailable");
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
  if (!video || !await videoSessionMatches(c.env as Env, username, video, sessionId)) {
    return c.text(subsonicError(70, "Video session expired"), 410, XML);
  }
  try {
    const response = await mediaArtifactResponse(c.env as Env, username, sessionId, artifact, c.req.raw,
      mapAssetRequest(c.req.raw, videoId, sessionId));
    return response;
  } catch (error) {
    if (error instanceof MediaLoaderError && (error.status === 404 || error.status === 410)) {
      await invalidateVideoSession(c.env as Env, username, video, sessionId);
      return c.text(subsonicError(70, "Video session expired; reload the playlist"), 410, XML);
    }
    return videoError(c, error, "Video asset is unavailable");
  }
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
  const requestedTrack = c.req.query("track") ?? null;
  const username = c.get("user").username;
  try {
    const session = await prepareVideoMedia(c.env as Env, result, username, c.req.raw.signal);
    const captionTrack = requestedTrack || session.captions[0]?.id;
    if (!captionTrack || !session.captions.some((track) => track.id === captionTrack)) {
      return c.text(subsonicError(70, "Caption track not found"), 404, XML);
    }
    const url = new URL(c.req.url);
    url.searchParams.set("track", captionTrack);
    const proxyRequest = new Request(url, { method: "GET", headers: c.req.raw.headers, signal: c.req.raw.signal });
    return await artifactWithRefresh(c.env as Env, username, result, "captions", proxyRequest);
  } catch (error) {
    return videoError(c, error, "Captions are unavailable");
  }
});

register("getCoverArt", async (c, next) => {
  const match = await lookupVideo(c);
  if (!match.matches) return next();
  if (!match.video) return videoNotFound(c);
  return c.body(null, 404);
});
