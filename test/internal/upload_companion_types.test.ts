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
//
// POST /storage/files/upload — the companion file types (lyric sidecars,
// text, images) that ride along with the music instead of being library
// entries of their own.
//
// Covers:
//  • .lrc / .ttml / .krc / .klrc / .txt / images are accepted with allow_all_file_types
//    off — they belong in a music folder
//  • a companion lands in R2 but gets no song_instances row (registering one
//    produced a phantom "Pending Uploads" track no metadata pass could fix)
//  • the suffix decides the stored Content-Type when the browser doesn't know
//    the extension, so a sidecar isn't filed as octet-stream
//  • audio still takes the full path: song row + returned instance id
//  • anything else is still refused while allow_all_file_types is off
//  • the companion set covers every sidecar extension the lyrics reader looks
//    for, so the two lists can't drift apart
//
// Run: npx tsx test/internal/upload_companion_types.test.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { filesRoutes } from "../../worker/src/endpoints/storage/files";
import { isAudioSuffix, isCompanionSuffix, COMPANION_SUFFIXES, AUDIO_SUFFIXES } from "../../worker/src/utils/demoMode";

declare global {
  type D1Database = unknown;
  type D1PreparedStatement = unknown;
  type Env = unknown;
}

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// Shims — R2 keeps what was written; D1 records every statement so the test
// can tell whether a song row was created.
// ---------------------------------------------------------------------------
function makeR2Bucket() {
  const store = new Map<string, { contentType: string }>();
  return {
    store,
    async put(key: string, _body: unknown, opts?: { httpMetadata?: { contentType?: string } }) {
      store.set(key, { contentType: opts?.httpMetadata?.contentType || "application/octet-stream" });
    },
    async head(key: string) { return store.has(key) ? { key } : null; },
    async get() { return null; },
    async delete() { /* unused here */ },
    async list() { return { objects: [], delimitedPrefixes: [] as string[], truncated: false, cursor: undefined }; },
  };
}

function makeD1() {
  const executed: string[] = [];
  const db = {
    executed,
    prepare(sql: string) {
      const flat = sql.trim().replace(/\s+/g, " ");
      const stmt = {
        sql: flat,
        args: [] as unknown[],
        bind(...args: unknown[]) { stmt.args = args; return stmt; },
        // feature_strings is absent → allow_all_file_types resolves false and
        // worker_pool_enabled falls back to its default.
        async first<T = unknown>(): Promise<T | null> {
          executed.push(flat);
          if (flat.includes("FROM user_permissions")) return { enabled: 1, max_rph: 0 } as T;
          return null;
        },
        async all<T = unknown>() {
          executed.push(flat);
          return { results: [] as T[], success: true as const, meta: {} };
        },
        async run() {
          executed.push(flat);
          return { success: true as const, meta: { changes: 0 } };
        },
      };
      return stmt;
    },
    async batch(stmts: Array<{ run(): Promise<unknown> }>) {
      const out = [] as unknown[];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
  return db;
}

function makeApp(bucket: ReturnType<typeof makeR2Bucket>, db: ReturnType<typeof makeD1>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "root", level: 3, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/storage", filesRoutes);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env: Record<string, any> = { DB: db, MUSIC_BUCKET: bucket };
  return async function upload(name: string, contentType: string | null, path = "") {
    const qs = new URLSearchParams({ name, source: "r2" });
    if (path) qs.set("path", path);
    const headers: Record<string, string> = { "Content-Length": "4" };
    if (contentType) headers["Content-Type"] = contentType;
    const req = new Request(`http://test/storage/files/upload?${qs.toString()}`, {
      method: "POST",
      headers,
      body: new Uint8Array([1, 2, 3, 4]),
    });
    const resp = await app.fetch(req, env);
    return { status: resp.status, body: await resp.json() as Record<string, unknown> };
  };
}

function insertedSongRow(db: ReturnType<typeof makeD1>): boolean {
  return db.executed.some((s) => s.includes("INSERT INTO song_instances"));
}

async function main() {
  console.log("companion types are accepted with allow_all_file_types off:");
  {
    for (const [name, sent] of [
      ["lyrics.lrc", null],
      ["lyrics.ttml", null],
      ["lyrics.krc", null],
      ["lyrics.klrc", null],
      ["notes.txt", "text/plain"],
      ["cover.jpg", "image/jpeg"],
      ["back.png", "image/png"],
      ["art.webp", "image/webp"],
    ] as Array<[string, string | null]>) {
      const bucket = makeR2Bucket();
      const db = makeD1();
      const upload = makeApp(bucket, db);
      const { status, body } = await upload(name, sent);
      assert(status === 200 && body.ok === true, `${name} → 200 ok`);
    }
  }

  console.log("a companion lands in R2 without becoming a library entry:");
  {
    const bucket = makeR2Bucket();
    const db = makeD1();
    const upload = makeApp(bucket, db);
    const { body } = await upload("01 track.lrc", null, "music/album");
    assert(bucket.store.has("music/album/01 track.lrc"), "written under the requested folder");
    assert(body.key === "music/album/01 track.lrc", "the key comes back");
    assert(body.id === undefined, "no instance id is handed out");
    assert(!insertedSongRow(db), "no song_instances row was inserted");
  }

  console.log("the suffix decides the Content-Type the browser couldn't name:");
  {
    const cases: Array<[string, string | null, string]> = [
      ["a.lrc", null, "text/plain; charset=utf-8"],
      // Browsers commonly fall back to octet-stream for unknown extensions.
      ["b.krc", "application/octet-stream", "text/plain; charset=utf-8"],
      ["c.klrc", "application/octet-stream", "text/plain; charset=utf-8"],
      ["d.ttml", null, "application/ttml+xml"],
      ["e.txt", null, "text/plain; charset=utf-8"],
      ["f.jpg", null, "image/jpeg"],
      ["g.png", null, "image/png"],
      ["h.webp", null, "image/webp"],
      // A type the browser does know is kept as sent.
      ["i.jpeg", "image/jpeg", "image/jpeg"],
    ];
    for (const [name, sent, want] of cases) {
      const bucket = makeR2Bucket();
      const db = makeD1();
      const upload = makeApp(bucket, db);
      await upload(name, sent);
      const got = bucket.store.get(`music/${name}`)?.contentType;
      assert(got === want, `${name} stored as ${want}${got === want ? "" : ` (got ${got})`}`);
    }
  }

  console.log("audio still takes the full path:");
  {
    const bucket = makeR2Bucket();
    const db = makeD1();
    const upload = makeApp(bucket, db);
    const { status, body } = await upload("song.flac", "audio/flac");
    assert(status === 200 && body.ok === true, "flac → 200 ok");
    assert(typeof body.id === "string" && (body.id as string).startsWith("si-upload-"), "an instance id is handed out");
    assert(insertedSongRow(db), "a song_instances row was inserted");
    assert(bucket.store.get("music/song.flac")?.contentType === "audio/flac", "stored as audio/flac");
  }

  console.log("everything else is still refused:");
  {
    for (const name of ["payload.exe", "doc.pdf", "bundle.zip", "script.js"]) {
      const bucket = makeR2Bucket();
      const db = makeD1();
      const upload = makeApp(bucket, db);
      const { status, body } = await upload(name, null);
      assert(status === 415 && body.ok === false, `${name} → 415`);
      assert(bucket.store.size === 0, `${name} never reached the bucket`);
    }
  }

  console.log("the two suffix sets stay coherent:");
  {
    assert(isCompanionSuffix("LRC") && isCompanionSuffix("Jpg"), "matching is case-insensitive");
    assert(!isCompanionSuffix("mp3") && isAudioSuffix("mp3"), "audio is not a companion");
    const overlap = [...COMPANION_SUFFIXES].filter((s) => AUDIO_SUFFIXES.has(s));
    assert(overlap.length === 0, `no suffix is in both sets${overlap.length ? ` (${overlap.join(", ")})` : ""}`);

    // The lyrics reader looks for these next to a track; if it can read them
    // back, the uploader has to accept them.
    const sidecar = readFileSync(join(__dirname, "..", "..", "worker", "src", "utils", "lrcSidecar.ts"), "utf8");
    const exts = (sidecar.match(/const SIDECAR_EXTS = \[([^\]]*)\]/)?.[1] ?? "")
      .split(",").map((s) => s.trim().replace(/^"\.|"$/g, "")).filter(Boolean);
    assert(exts.length >= 3, `found the reader's sidecar list (${exts.join(", ")})`);
    const missing = exts.filter((e) => !isCompanionSuffix(e));
    assert(missing.length === 0, missing.length ? `uploader rejects readable sidecars: ${missing.join(", ")}` : "every readable sidecar can be uploaded");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main();
