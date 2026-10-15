// SPDX-License-Identifier: AGPL-3.0-or-later

import { accountRevision } from "./accounts";
import { MediaLoaderError, requestMedia, type MediaSession } from "./loader";

function sessionKey(id: string): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) throw new MediaLoaderError("Invalid media session", 404);
  return `media_session:${id}`;
}

export async function rememberMediaSession(env: Env, username: string, session: MediaSession): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(session.expiresAt) || session.expiresAt <= now || session.expiresAt > now + 86_400) {
    throw new MediaLoaderError("Invalid media expiry");
  }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .bind(sessionKey(session.id), JSON.stringify({ username, session }), now),
    env.DB.prepare("DELETE FROM kv_store WHERE key GLOB 'media_session:*' AND updated_at < ?").bind(now - 86_400),
  ]);
}

export async function findMediaSession(env: Env, username: string, id: string): Promise<MediaSession | null> {
  const key = sessionKey(id);
  const row = await env.DB.prepare("SELECT value FROM kv_store WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return null;
  const value = JSON.parse(row.value) as { username: string; session: MediaSession };
  if (value.username !== username) return null;
  if (value.session.expiresAt <= Date.now() / 1000 || (value.session.provider && value.session.credentialRevision !== await accountRevision(env, username, value.session.provider))) {
    await env.DB.prepare("DELETE FROM kv_store WHERE key = ?").bind(key).run();
    return null;
  }
  return value.session;
}

export async function forgetMediaSession(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM kv_store WHERE key = ?").bind(sessionKey(id)).run();
}

export async function mediaArtifactResponse(
  env: Env,
  username: string,
  id: string,
  artifact: string,
  request: Request,
  mapAsset?: (artifact: string) => string,
): Promise<Response> {
  if (!await findMediaSession(env, username, id)) throw new MediaLoaderError("Media session expired", 410);
  if (!/^(stream|hls\.m3u8|captions|danmaku|file\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)$/.test(artifact)
    || artifact.includes("..")) throw new MediaLoaderError("Media artifact not found", 404);
  const query = new URLSearchParams();
  const requested = new URL(request.url).searchParams;
  for (const name of ["timeOffset", "bitRate", "size", "audioTrack", "format", "audioOnly", "track"]) {
    for (const value of requested.getAll(name)) query.append(name, value);
  }
  const headers = new Headers();
  const range = request.headers.get("Range");
  if (range && !artifact.endsWith(".m3u8")) headers.set("Range", range);
  const path = `/media/sessions/${id}/${artifact}`;
  const upstream = await requestMedia(env, `${path}${query.size ? `?${query}` : ""}`, {
    method: request.method === "HEAD" ? "HEAD" : "GET", headers, signal: request.signal,
  });
  if (upstream.status === 404) {
    await upstream.body?.cancel();
    if (!artifact.startsWith("file/") && artifact !== "captions") await forgetMediaSession(env, id);
    throw new MediaLoaderError("Media artifact is unavailable", 404);
  }
  if (!upstream.ok && upstream.status !== 416) {
    await upstream.body?.cancel();
    throw new MediaLoaderError("Media playback failed", upstream.status < 500 ? upstream.status : 502);
  }
  const responseHeaders = new Headers({ "Cache-Control": "private, no-store" });
  for (const name of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  if (artifact.endsWith(".m3u8") && request.method !== "HEAD" && upstream.ok) {
    const manifest = await upstream.text();
    if (manifest.length > 262_144) throw new MediaLoaderError("Media playlist is too large");
    const rewrite = (uri: string): string => {
      const resolved = new URL(uri, `https://media.invalid${path}`);
      const prefix = `/media/sessions/${id}/`;
      if (resolved.origin !== "https://media.invalid" || !resolved.pathname.startsWith(`${prefix}file/`)) {
        throw new MediaLoaderError("Invalid media playlist resource");
      }
      const relative = resolved.pathname.slice(prefix.length);
      if (!/^file\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(relative) || relative.includes("..")) {
        throw new MediaLoaderError("Invalid media playlist resource");
      }
      return mapAsset ? mapAsset(relative) : `/edgesonic/media/${id}/${relative}`;
    };
    const rewritten = manifest.split(/\r?\n/).map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${rewrite(uri)}"`);
      return rewrite(line.trim());
    }).join("\n");
    responseHeaders.delete("Content-Length");
    responseHeaders.delete("Content-Range");
    responseHeaders.delete("Accept-Ranges");
    responseHeaders.delete("ETag");
    responseHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
    return new Response(rewritten, { status: upstream.status, headers: responseHeaders });
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
