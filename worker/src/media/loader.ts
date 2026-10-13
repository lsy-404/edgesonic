// SPDX-License-Identifier: AGPL-3.0-or-later

import { getFeatureString } from "../utils/features";

export interface MediaTrack {
  id: string;
  language?: string;
  title?: string;
}

export interface MediaSession {
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
  const [base, secret] = await Promise.all([
    getFeatureString(env, "external_transcoder_url", ""),
    env.DB.prepare("SELECT value FROM external_secrets WHERE key = 'external_transcoder_key'").first<{ value: string }>(),
  ]);
  if (!base || !secret?.value) throw new MediaLoaderError("Media loader is not configured", 503);
  const headers = new Headers(init.headers);
  headers.set("X-EdgeSonic-Container-Key", secret.value);
  return fetch(`${base.replace(/\/+$/, "")}${path}`, { ...init, headers, redirect: "error" });
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
  return session;
}

export async function resolveExternalMedia(env: Env, url: string, signal?: AbortSignal): Promise<MediaSession> {
  return readMediaSession(await requestMedia(env, "/media/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
    signal,
  }));
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
