// SPDX-License-Identifier: AGPL-3.0-or-later
export interface VideoSummary {
  id: string;
  title: string;
  provider: "file" | "youtube" | "bilibili";
  duration: number | null;
  width: number | null;
  height: number | null;
  suffix: string | null;
  contentType: string | null;
  size: number | null;
}
export interface MediaSession {
  id: string;
  title: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  expiresAt: number;
  audioTracks: Array<{ id: string; language?: string; title?: string }>;
  captions: Array<{ id: string; language?: string; title?: string }>;
}
export interface VideoAudioLink { audioId: string; videoId: string; audioTitle: string; videoTitle: string; offsetMs: number }

export class VideoRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  let data: { ok?: boolean; error?: string } & Record<string, unknown>;
  try { data = await response.json() as typeof data; }
  catch { throw new VideoRequestError("The service returned an unreadable response.", response.status); }
  if (!response.ok || data.ok === false) throw new VideoRequestError(data.error || "The request could not be completed.", response.status);
  return data as T;
}
function post(body: unknown): RequestInit { return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }; }

export function listVideos(query: string, offset = 0, limit = 40) {
  const params = new URLSearchParams({ query, offset: String(offset), limit: String(limit) });
  return request<{ ok: true; videos: VideoSummary[]; total: number }>(`/edgesonic/videos?${params}`);
}
export function saveExternalVideo(url: string) { return request<{ ok: true; video: VideoSummary }>("/edgesonic/videos/external", post({ url })); }
export function importVideoFile(sourceId: string, path: string) { return request<{ ok: true; video: VideoSummary }>("/edgesonic/videos/import", post({ sourceId, path })); }
export function listVideoLinks(query: { audioId?: string; videoId?: string }) {
  return request<{ ok: true; links: VideoAudioLink[] }>(`/edgesonic/videos/links?${new URLSearchParams(query)}`);
}
export function saveVideoLink(videoId: string, audioId: string, offsetMs: number) {
  return request<{ ok: true }>(`/edgesonic/videos/${encodeURIComponent(videoId)}/links/${encodeURIComponent(audioId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ offsetMs }) });
}
export function removeVideoLink(videoId: string, audioId: string) {
  return request<{ ok: true }>(`/edgesonic/videos/${encodeURIComponent(videoId)}/links/${encodeURIComponent(audioId)}`, { method: "DELETE" });
}
export function getVideoPlayback(videoId: string) { return request<{ ok: true; session: MediaSession }>(`/edgesonic/videos/${encodeURIComponent(videoId)}/playback`); }
export function resolveExternalVideo(url: string) { return request<{ ok: true; session: MediaSession }>("/edgesonic/media/resolve", post({ url })); }
export const mediaManifestUrl = (sessionId: string, audioOnly = false) => `/edgesonic/media/${encodeURIComponent(sessionId)}/hls.m3u8${audioOnly ? "?audioOnly=1" : ""}`;
export const captionTrackUrl = (sessionId: string, track: string) => `/edgesonic/media/${encodeURIComponent(sessionId)}/captions?${new URLSearchParams({ track, format: "vtt" })}`;
