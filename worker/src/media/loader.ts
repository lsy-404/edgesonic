// SPDX-License-Identifier: AGPL-3.0-or-later

import { videoReference } from "./references";
import { accountCookies, accountRevision } from "./accounts";

export interface MediaTrack {
  id: string;
  language?: string;
  title?: string;
}

export interface MediaSession {
  transport: "hls" | "file" | "iframe";
  sourceUrl?: string;
  provider?: "youtube" | "bilibili";
  credentialRevision?: string;
  id: string;
  title: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  expiresAt: number;
  audioTracks: MediaTrack[];
  captions: MediaTrack[];
}

export class MediaLoaderError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = "MediaLoaderError";
  }
}

export async function requestMedia(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  if (!path.startsWith("/media/") || path.includes("..")) throw new MediaLoaderError("Invalid media path", 400);
  if (!env.MediaContainer) throw new MediaLoaderError("Full playback requires the integrated media container", 503);
  const stub = env.MediaContainer.getByName("media");
  const response = await stub.fetch(new Request(`https://media.internal${path}`, init));
  return response;
}

export async function readMediaSession(response: Response): Promise<MediaSession> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new MediaLoaderError("Media could not be prepared", response.status >= 400 && response.status < 500 ? response.status : 502);
  }
  const session = await response.json<MediaSession>();
  if (!session.id || !/^[A-Za-z0-9_-]{16,128}$/.test(session.id)
    || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now() / 1000
    || !Array.isArray(session.audioTracks) || !Array.isArray(session.captions)) {
    throw new MediaLoaderError("Invalid media session");
  }
  return { ...session, transport: "hls" };
}

export async function resolveExternalMedia(env: Env, url: string, signal?: AbortSignal, username?: string): Promise<MediaSession> {
  const ref = await videoReference(url);
  const credentialRevision = username ? await accountRevision(env, username, ref.provider) : undefined;
  const cookies = username ? await accountCookies(env, username, ref.provider) : undefined;
  const session = await readMediaSession(await requestMedia(env, "/media/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: ref.url, cookies }),
    signal,
  }));
  return { ...session, provider: ref.provider, credentialRevision };
}

export async function uploadVideoMedia(
  env: Env, body: ReadableStream<Uint8Array>, title: string, suffix: string, signal?: AbortSignal,
): Promise<MediaSession> {
  const params = new URLSearchParams({ title, suffix });
  return readMediaSession(await requestMedia(env, `/media/files?${params}`, {
    method: "POST", body, signal,
    headers: { "Content-Type": "application/octet-stream" },
  }));
}
