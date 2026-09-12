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
import { R2_SOURCE_ID, findR2EntryByPath } from "../../utils/storageResolver";

export const browseRoutes = new Hono();

// GET /storage/files/list?source=r2|<sourceId>&path=<dir>
browseRoutes.get("/files/list", permissionMiddleware("download"), async (c) => {
  const env = c.env as Env;
  const source = c.req.query("source") || "r2";
  const path = (c.req.query("path") || "").replace(/^\/+|\/+$/g, "");

  if (source === "r2") {
    const parent = path
      ? await findR2EntryByPath(env.DB, path)
      : null;
    if (path && (!parent || parent.kind !== "folder")) {
      return c.json({ ok: false, error: "Folder not found" }, 404);
    }
    const parentId = parent?.id || null;
    const rows = await env.DB.prepare(
      `SELECT e.id, e.path, e.display_name, e.kind, e.object_id, e.instance_id,
              e.updated_at, o.physical_key, o.content_type, o.size
         FROM storage_entries e
         LEFT JOIN storage_objects o ON o.id = e.object_id
        WHERE e.source_id = ? AND e.parent_id IS ?
        ORDER BY e.kind DESC, e.display_name COLLATE NOCASE ASC`,
    ).bind(R2_SOURCE_ID, parentId).all<{
      id: string; path: string; display_name: string; kind: "file" | "folder";
      object_id: string | null; instance_id: string | null; updated_at: number;
      physical_key: string | null; content_type: string | null; size: number | null;
    }>();
    return c.json({
      ok: true,
      source: "r2",
      path,
      dirs: rows.results.filter((row) => row.kind === "folder").map((row) => ({
        name: row.display_name,
        modifiedAt: row.updated_at,
      })),
      files: rows.results.filter((row) => row.kind === "file" && row.physical_key).map((row) => ({
        name: row.display_name,
        size: row.size || 0,
        contentType: row.content_type,
        uri: `r2://${row.physical_key}`,
        modifiedAt: row.updated_at,
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

// GET /storage/files/resolve?uri=<storage-uri>
// Resolve an entry from the file browser to its catalog song without changing
// the direct file stream used for immediate playback.
browseRoutes.get("/files/resolve", permissionMiddleware("download"), async (c) => {
  const uri = c.req.query("uri") || "";
  if (!/^(r2|webdav):\/\/.+$/i.test(uri) || /[\r\n]/.test(uri)) {
    return c.json({ ok: false, error: "Invalid storage URI" }, 400);
  }
  const env = c.env as Env;
  const song = await env.DB.prepare(
    `SELECT sm.id, sm.title, ar.name AS artist, al.name AS album,
            sm.cover_r2_key AS coverArt, sm.duration
       FROM song_instances si
       JOIN song_masters sm ON sm.id = si.master_id
       LEFT JOIN artists ar ON ar.id = sm.artist_id
       LEFT JOIN albums al ON al.id = sm.album_id
      WHERE si.storage_uri = ? AND si.missing = 0
      ORDER BY CASE WHEN si.source_type = 'original' THEN 0 ELSE 1 END, si.created_at ASC
      LIMIT 1`,
  ).bind(uri).first<{
    id: string; title: string; artist: string | null; album: string | null;
    coverArt: string | null; duration: number | null;
  }>();
  if (!song) return c.json({ ok: false, error: "Song not found" }, 404);
  return c.json({ ok: true, song });
});
