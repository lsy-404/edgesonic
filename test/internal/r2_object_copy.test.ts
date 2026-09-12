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

import { copyR2Object, createR2CopyRequestState, type R2CopyEnv } from "../../worker/src/utils/r2ObjectCopy";
import { installFixedLengthStream } from "../helpers/fixedLengthStream";

installFixedLengthStream();

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

interface Item { body: Uint8Array; contentType: string }

function makeBucket() {
  const store = new Map<string, Item>();
  let puts = 0;
  return {
    store,
    get puts() { return puts; },
    async get(key: string) {
      const item = store.get(key);
      if (!item) return null;
      return {
        key,
        size: item.body.byteLength,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(item.body);
            controller.close();
          },
        }),
        httpMetadata: { contentType: item.contentType },
        customMetadata: {},
      };
    },
    async put(key: string, body: unknown, opts?: { httpMetadata?: { contentType?: string } }) {
      puts++;
      const reader = (body as ReadableStream<Uint8Array>).getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
        total += next.value.byteLength;
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      store.set(key, { body: bytes, contentType: opts?.httpMetadata?.contentType || "application/octet-stream" });
    },
    async delete(key: string) { store.delete(key); },
    async list() { return { objects: [], truncated: false }; },
  };
}

function makeEnv(bucket: ReturnType<typeof makeBucket>, withCopyCredentials: boolean): R2CopyEnv {
  return {
    MUSIC_BUCKET: bucket as unknown as R2Bucket,
    CF_ACCOUNT_ID: withCopyCredentials ? "account-id" : undefined,
    R2_BUCKET_NAME: "music-bucket",
    R2_COPY_ACCESS_KEY_ID: withCopyCredentials ? "copy-access" : undefined,
    R2_COPY_SECRET_ACCESS_KEY: withCopyCredentials ? "copy-secret" : undefined,
  };
}

async function main() {
  const originalFetch = globalThis.fetch;
  try {
    console.log("\nserver-side copy → signs CopyObject and avoids body transfer:");
    {
      const bucket = makeBucket();
      bucket.store.set("music/原曲.flac", { body: new Uint8Array([1, 2]), contentType: "audio/flac" });
      let request: { url: string; init?: RequestInit } | null = null;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        request = { url: String(input), init };
        return new Response(null, { status: 200 });
      }) as typeof fetch;

      const copied = await copyR2Object(makeEnv(bucket, true), "music/原曲.flac", "objects/object-1.flac");
      const headers = new Headers(request?.init?.headers);
      assert(copied, "CopyObject returns success");
      assert(bucket.puts === 0, "binding PUT is skipped");
      assert(request?.init?.method === "PUT", "CopyObject uses PUT");
      assert(request?.url.endsWith("/objects/object-1.flac"), `destination key is in URL (got ${request?.url})`);
      assert(headers.get("x-amz-copy-source") === "/music-bucket/music/%E5%8E%9F%E6%9B%B2.flac", `source key is encoded (got ${headers.get("x-amz-copy-source")})`);
      assert(headers.get("x-amz-metadata-directive") === "COPY", "metadata directive preserves source metadata");
      assert(headers.get("authorization")?.includes("x-amz-copy-source"), "copy source is covered by SigV4");
    }

    console.log("\nserver-side copy fallback → failed CopyObject uses fixed-length binding copy once:");
    {
      const bucket = makeBucket();
      bucket.store.set("music/source.mp3", { body: new Uint8Array([7, 8, 9]), contentType: "audio/mpeg" });
      let fetchCalls = 0;
      globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response(null, { status: 403 });
      }) as typeof fetch;
      const env = makeEnv(bucket, true);
      const state = createR2CopyRequestState();
      const first = await copyR2Object(env, "music/source.mp3", "objects/source.mp3", state);
      const second = await copyR2Object(env, "music/source.mp3", "objects/source-2.mp3", state);
      assert(first && second, "binding fallback succeeds after server copy rejection");
      assert(fetchCalls === 1, "server copy is disabled for the rest of the request after rejection");
      assert(bucket.puts === 2, "each fallback copies through the binding");
      assert(Array.from(bucket.store.get("objects/source.mp3")?.body || []).join(",") === "7,8,9", "fallback preserves bytes");
    }

    console.log("\nmissing copy credentials → existing binding path remains available:");
    {
      const bucket = makeBucket();
      bucket.store.set("music/source.flac", { body: new Uint8Array([3]), contentType: "audio/flac" });
      let fetchCalls = 0;
      globalThis.fetch = (async () => { fetchCalls++; return new Response(null, { status: 500 }); }) as typeof fetch;
      const copied = await copyR2Object(makeEnv(bucket, false), "music/source.flac", "objects/source.flac");
      assert(copied, "binding path succeeds without copy credentials");
      assert(fetchCalls === 0, "no S3 request without write credentials");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) FAILED.`);
  if (failures) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
