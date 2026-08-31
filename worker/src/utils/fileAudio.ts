// SPDX-License-Identifier: AGPL-3.0-or-later

import { createR2Adapter } from "../adapters/r2";
import { encodePath } from "../endpoints/storage/scan";
import { srcBaseUrl, type SourceRow } from "./slices";

function normalizeFilePath(path: string | undefined): string | null {
  const normalized = (path || "").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) return null;
  return normalized;
}

function streamContentType(contentType: string, path: string): string {
  const base = contentType.split(";", 1)[0].trim().toLowerCase();
  if (base && base !== "application/octet-stream") return contentType;
  switch (path.split(".").pop()?.toLowerCase()) {
    case "flac": return "audio/flac";
    case "mp3": return "audio/mpeg";
    case "m4a": return "audio/mp4";
    case "aac": return "audio/aac";
    case "ogg": return "audio/ogg";
    case "opus": return "audio/opus";
    case "wav": return "audio/wav";
    case "webm": return "audio/webm";
    default: return contentType;
  }
}

function streamHeaders(input: {
  contentType: string;
  contentLength: number | null;
  acceptRanges: boolean;
  contentRange?: string | null;
}, path: string): Headers {
  const headers = new Headers();
  headers.set("Content-Type", streamContentType(input.contentType, path));
  if (input.contentLength !== null) headers.set("Content-Length", String(input.contentLength));
  if (input.acceptRanges) headers.set("Accept-Ranges", "bytes");
  if (input.contentRange) headers.set("Content-Range", input.contentRange);
  headers.set("Cache-Control", "private, max-age=3600");
  return headers;
}

function jsonError(status: 400 | 404, error: string): Response {
  return Response.json({ ok: false, error }, { status });
}

export async function streamStoredFile(env: Env, input: {
  source: string | undefined;
  path: string | undefined;
  range: string | undefined;
}): Promise<Response> {
  const source = input.source || "r2";
  const path = normalizeFilePath(input.path);
  if (!path) return jsonError(400, "Invalid file path");

  if (source === "r2") {
    const result = await createR2Adapter(env.MUSIC_BUCKET).stream(`r2://${path}`, input.range);
    if (!result.body || result.statusCode >= 400) return new Response(null, { status: result.statusCode });
    return new Response(result.body, {
      status: result.statusCode,
      headers: streamHeaders(result, path),
    });
  }

  const src = await env.DB.prepare(
    "SELECT id, base_url, username, password, root_path FROM storage_sources WHERE id = ? AND enabled = 1",
  ).bind(source).first<SourceRow>();
  if (!src) return jsonError(404, "Source not found");

  const headers = new Headers({ Authorization: `Basic ${btoa(`${src.username || ""}:${src.password || ""}`)}` });
  if (input.range) headers.set("Range", input.range);
  const response = await fetch(`${srcBaseUrl(src)}/${encodePath(path)}`, { headers });
  if (!response.body || (response.status !== 200 && response.status !== 206)) return new Response(null, { status: response.status });
  return new Response(response.body, {
    status: response.status,
    headers: streamHeaders({
      contentType: response.headers.get("Content-Type") || "application/octet-stream",
      contentLength: Number(response.headers.get("Content-Length")) || null,
      acceptRanges: response.headers.get("Accept-Ranges") === "bytes",
      contentRange: response.headers.get("Content-Range"),
    }, path),
  });
}
