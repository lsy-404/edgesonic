// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// endpoints/filebrowse.ts; the scanTags sibling moved to tag/read.ts.
import { Hono } from "hono";
import { permissionMiddleware } from "../../auth";
import { parseMultistatus, stripTrailingSlash, encodePath } from "./scan";
import { srcBaseUrl, type SourceRow } from "../../utils/slices";
import { createR2Adapter } from "../../adapters/r2";

export const browseRoutes = new Hono();

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

// GET /storage/files/list?source=r2|<sourceId>&path=<dir>
browseRoutes.get("/files/list", permissionMiddleware("download"), async (c) => {
  const env = c.env as Env;
  const source = c.req.query("source") || "r2";
  const path = (c.req.query("path") || "").replace(/^\/+|\/+$/g, "");

  if (source === "r2") {
    const prefix = path ? `${path}/` : "";
    const listing = await env.MUSIC_BUCKET.list({ prefix, delimiter: "/" });
    return c.json({
      ok: true,
      source: "r2",
      path,
      dirs: listing.delimitedPrefixes.map((p) => ({
        name: p.substring(prefix.length).replace(/\/$/, ""),
        modifiedAt: null,
      })),
      // ".keep" is the 0-byte marker files/mkdir drops to make an otherwise
      // real-object-free R2 "folder" show up via the delimiter above — hide
      // it from the folder's own contents so it doesn't look like a stray file.
      files: listing.objects
        .filter((o) => o.key.substring(prefix.length) !== ".keep")
        .map((o) => ({
          name: o.key.substring(prefix.length),
          size: o.size,
          contentType: o.httpMetadata?.contentType || null,
          uri: `r2://${o.key}`,
          modifiedAt: o.uploaded ? Math.floor(o.uploaded.getTime() / 1000) : null,
        })),
    });
  }

  const src = await env.DB.prepare(
    "SELECT id, base_url, username, password, root_path FROM storage_sources WHERE id = ? AND enabled = 1"
  ).bind(source).first<SourceRow>();
  if (!src) return c.json({ ok: false, error: "Source not found" }, 404);

  const baseUrl = srcBaseUrl(src);
  const basePath = stripTrailingSlash(new URL(baseUrl).pathname);
  const url = baseUrl + "/" + (path ? encodePath(path) + "/" : "");
  const resp = await fetch(url, {
    method: "PROPFIND",
    headers: {
      Authorization: `Basic ${btoa(`${src.username || ""}:${src.password || ""}`)}`,
      Depth: "1",
      "Content-Type": "application/xml",
    },
    body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getcontenttype/><d:getlastmodified/></d:prop></d:propfind>`,
  });
  if (!resp.ok && resp.status !== 207) {
    return c.json({ ok: false, error: `PROPFIND failed: HTTP ${resp.status}` }, 502);
  }

  const entries = parseMultistatus(await resp.text(), basePath)
    .filter((e) => e.path !== path && e.path !== "");
  return c.json({
    ok: true,
    source: src.id,
    path,
    dirs: entries.filter((e) => e.isDir).map((e) => ({
      name: e.path.split("/").pop() || e.path,
      modifiedAt: e.lastModified,
    })),
    files: entries.filter((e) => !e.isDir).map((e) => ({
      name: e.path.split("/").pop() || e.path,
      size: e.size,
      contentType: e.contentType,
      uri: `webdav://${src.id}/${e.path}`,
      modifiedAt: e.lastModified,
    })),
  });
});

// GET /storage/files/stream?source=r2|<sourceId>&path=<full-file-path>
// Streams a browsed audio file even before metadata scanning has registered a
// song instance, while retaining the same download permission as file listing.
browseRoutes.get("/files/stream", permissionMiddleware("download"), async (c) => {
  const env = c.env as Env;
  const source = c.req.query("source") || "r2";
  const path = normalizeFilePath(c.req.query("path"));
  if (!path) return c.json({ ok: false, error: "Invalid file path" }, 400);
  const range = c.req.header("Range");

  if (source === "r2") {
    const result = await createR2Adapter(env.MUSIC_BUCKET).stream(`r2://${path}`, range);
    if (!result.body || result.statusCode >= 400) return c.body(null, result.statusCode as never);
    return new Response(result.body, {
      status: result.statusCode,
      headers: streamHeaders(result, path),
    });
  }

  const src = await env.DB.prepare(
    "SELECT id, base_url, username, password, root_path FROM storage_sources WHERE id = ? AND enabled = 1",
  ).bind(source).first<SourceRow>();
  if (!src) return c.json({ ok: false, error: "Source not found" }, 404);

  const headers = new Headers({ Authorization: `Basic ${btoa(`${src.username || ""}:${src.password || ""}`)}` });
  if (range) headers.set("Range", range);
  const response = await fetch(`${srcBaseUrl(src)}/${encodePath(path)}`, { headers });
  if (!response.body || (response.status !== 200 && response.status !== 206)) return c.body(null, response.status as never);
  return new Response(response.body, {
    status: response.status,
    headers: streamHeaders({
      contentType: response.headers.get("Content-Type") || "application/octet-stream",
      contentLength: Number(response.headers.get("Content-Length")) || null,
      acceptRanges: response.headers.get("Accept-Ranges") === "bytes",
      contentRange: response.headers.get("Content-Range"),
    }, path),
  });
});
