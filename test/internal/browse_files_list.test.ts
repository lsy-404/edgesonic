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

// GET /storage/files/list, r2 branch: verifies an empty folder created by
// files/mkdir (a "<path>/.keep" marker object) shows up as a directory in its
// parent listing, and that ".keep" itself never leaks out as a visible file
// when browsing into that folder.
//
// Run: npx tsx test/internal/browse_files_list.test.ts

import { Hono } from "hono";
import { browseRoutes } from "../../worker/src/endpoints/storage/browse";
import { mediaRoutes } from "../../worker/src/endpoints/subsonic/media";

declare global { type D1Database = unknown; type Env = unknown; }

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// In-memory R2 bucket shim with delimiter-aware list() (mirrors R2's actual
// commonPrefix-grouping semantics closely enough for this test).
// ---------------------------------------------------------------------------
interface R2Item { key: string; size: number; contentType: string; uploaded: Date; bytes: Uint8Array }

function makeR2Bucket() {
  const store = new Map<string, R2Item>();
  return {
    async put(key: string, body: unknown, opts?: { httpMetadata?: { contentType?: string } }) {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array([1, 2, 3, 4]);
      store.set(key, { key, size: bytes.byteLength, bytes, contentType: opts?.httpMetadata?.contentType || "application/octet-stream", uploaded: new Date("2026-08-25T12:34:56Z") });
    },
    async list({ prefix, delimiter }: { prefix: string; delimiter: string }) {
      const objects: (R2Item & { httpMetadata: { contentType: string } })[] = [];
      const prefixSet = new Set<string>();
      for (const item of store.values()) {
        if (!item.key.startsWith(prefix)) continue;
        const rest = item.key.substring(prefix.length);
        const idx = rest.indexOf(delimiter);
        if (idx >= 0) {
          prefixSet.add(prefix + rest.substring(0, idx + delimiter.length));
        } else {
          objects.push({ ...item, httpMetadata: { contentType: item.contentType } });
        }
      }
      return { objects, delimitedPrefixes: Array.from(prefixSet) };
    },
    async get(key: string, opts?: { range?: { offset: number; length?: number } }) {
      const item = store.get(key);
      if (!item) return null;
      const start = opts?.range?.offset || 0;
      const end = opts?.range?.length ? start + opts.range.length : undefined;
      const bytes = item.bytes.slice(start, end);
      return {
        body: new Blob([bytes]).stream(),
        size: item.size,
        httpMetadata: { contentType: item.contentType },
      };
    },
  };
}

function makeApp(bucket: ReturnType<typeof makeR2Bucket>, sourceRow?: Record<string, unknown>, resolvedSong?: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "root", level: 3, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/storage", browseRoutes);
  app.route("/rest", mediaRoutes);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env: Record<string, any> = {
    DB: { prepare(sql: string) { return { bind() { return this; }, async first() {
      if (sql.includes("FROM song_instances")) return resolvedSong || null;
      return sql.includes("FROM storage_sources") ? sourceRow || null : { enabled: 1, max_rph: 0 };
    } }; } },
    MUSIC_BUCKET: bucket,
  };

  return {
    async get(url: string, headers?: HeadersInit) { return app.fetch(new Request(`http://test${url}`, { headers }), env); },
  };
}

async function main() {
  const bucket = makeR2Bucket();
  await bucket.put("music/newfolder/.keep", null, { httpMetadata: { contentType: "application/x-directory" } });
  await bucket.put("music/newfolder/track.mp3", null, { httpMetadata: { contentType: "audio/mpeg" } });
  const app = makeApp(bucket);

  console.log("\nfiles/list r2 parent → shows the marker-only folder as a dir:");
  {
    const r = await app.get("/storage/files/list?source=r2&path=music");
    const j = await r.json<{ ok: boolean; dirs: { name: string }[]; files: { name: string }[] }>();
    assert(j.ok, "ok=true");
    assert(j.dirs.some((d) => d.name === "newfolder"), `dirs includes 'newfolder' (got ${JSON.stringify(j.dirs)})`);
    assert(!j.files.some((f) => f.name === ".keep"), "no '.keep' leaked into the parent's file list");
  }

  console.log("\nfiles/list r2 inside folder → .keep hidden, real file kept:");
  {
    const r = await app.get("/storage/files/list?source=r2&path=music/newfolder");
    const j = await r.json<{ ok: boolean; files: { name: string; modifiedAt: number | null }[] }>();
    assert(j.ok, "ok=true");
    assert(!j.files.some((f) => f.name === ".keep"), "'.keep' not present in its own folder's listing");
    assert(j.files.some((f) => f.name === "track.mp3"), "real file 'track.mp3' still listed");
    assert(j.files.find((f) => f.name === "track.mp3")?.modifiedAt === 1787661296, "R2 upload time is returned as unix seconds");
  }

  console.log("\nstreamFile r2 → serves an unscanned file with media and range headers:");
  {
    await bucket.put("music/newfolder/direct.flac", new Uint8Array([10, 11, 12, 13]), { httpMetadata: { contentType: "application/octet-stream" } });
    const full = await app.get("/rest/streamFile?source=r2&path=music/newfolder/direct.flac");
    assert(full.status === 200, "full stream returns 200");
    assert(full.headers.get("Content-Type") === "audio/flac", "octet-stream FLAC receives a browser-playable MIME type");
    assert(full.headers.get("Accept-Ranges") === "bytes", "full stream advertises byte ranges");
    assert((await full.arrayBuffer()).byteLength === 4, "full stream preserves bytes");

    const ranged = await app.get("/rest/streamFile?source=r2&path=music/newfolder/direct.flac", { Range: "bytes=1-2" });
    assert(ranged.status === 206, "range stream returns 206");
    assert(ranged.headers.get("Content-Range") === "bytes 1-2/4", "range stream reports the selected byte span");
    assert((await ranged.arrayBuffer()).byteLength === 2, "range stream preserves only requested bytes");

    const invalid = await app.get("/rest/streamFile?source=r2&path=music/../outside.flac");
    assert(invalid.status === 400, "path traversal is rejected");
  }

  console.log("\nfiles/resolve → binds a browsed object to its catalog song:");
  {
    const resolveApp = makeApp(bucket, undefined, {
      id: "sg-json",
      title: "JSON lyric song",
      artist: "Artist",
      album: "Album",
      coverArt: "cover-1",
      duration: 245,
    });
    const r = await resolveApp.get(`/storage/files/resolve?uri=${encodeURIComponent("r2://music/JSON lyric song.flac")}`);
    const j = await r.json<{ ok: boolean; song?: { id: string; title: string; duration: number } }>();
    assert(r.status === 200 && j.ok, `matched storage URI returns 200 ok (got ${r.status}: ${JSON.stringify(j)})`);
    assert(j.song?.id === "sg-json" && j.song.title === "JSON lyric song" && j.song.duration === 245,
      "returns the catalog identity and display metadata");

    const miss = await makeApp(bucket).get(`/storage/files/resolve?uri=${encodeURIComponent("r2://music/not-scanned.flac")}`);
    assert(miss.status === 404, "unscanned file returns a non-fatal 404");
  }

  console.log("\nfiles/list WebDAV → requests and returns last-modified time:");
  {
    const originalFetch = globalThis.fetch;
    let requestedBody = "";
    globalThis.fetch = async (_input, init) => {
      requestedBody = String(init?.body || "");
      return new Response(`<?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:">
          <d:response>
            <d:href>/root/music/</d:href>
            <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
          </d:response>
          <d:response>
            <d:href>/root/music/album/</d:href>
            <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>Mon, 24 Aug 2026 10:00:00 GMT</d:getlastmodified></d:prop></d:propstat>
          </d:response>
          <d:response>
            <d:href>/root/music/track.mp3</d:href>
            <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>123</d:getcontentlength><d:getcontenttype>audio/mpeg</d:getcontenttype><d:getlastmodified>Tue, 25 Aug 2026 12:34:56 GMT</d:getlastmodified></d:prop></d:propstat>
          </d:response>
        </d:multistatus>`, { status: 207 });
    };
    try {
      const davApp = makeApp(bucket, {
        id: "dav",
        base_url: "https://dav.example/root",
        username: "user",
        password: "pass",
        root_path: null,
      });
      const r = await davApp.get("/storage/files/list?source=dav&path=music");
      const j = await r.json<{
        ok: boolean;
        dirs: { name: string; modifiedAt: number | null }[];
        files: { name: string; modifiedAt: number | null }[];
      }>();
      assert(requestedBody.includes("getlastmodified"), "PROPFIND asks for getlastmodified");
      assert(j.dirs[0]?.modifiedAt === 1787565600, "WebDAV directory time is returned as unix seconds");
      assert(j.files[0]?.modifiedAt === 1787661296, "WebDAV file time is returned as unix seconds");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  console.log(`\n${failures === 0 ? "All tests passed." : `${failures} test(s) FAILED.`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
