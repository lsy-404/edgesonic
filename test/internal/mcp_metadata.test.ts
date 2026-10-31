// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchMetadata, resolveMetadata } from "../../shared/scrape/local";
import { searchMetadata as cloudSearch } from "../../worker/src/mcp/metadata";

test("local and cloud metadata use provider transport and configured priority", async () => {
  const previous = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url.includes("albums.json")) return Response.json({ albums: [{ slug: "album", name: "Album", year: "2020", vocal: ["Singer"], produce: ["Producer"], songs: [{ title: "Song" }] }] });
    if (url.includes("albums/album.json")) return Response.json({ name: "Album", year: "2020", produce: ["Producer"], songs: [{ title: "Song", lyrics: [{ time: 1.25, text: "words" }] }] });
    throw new Error("provider offline");
  };
  try {
    const local = await searchMetadata({ query: "Song", sources: ["lrc"] });
    assert.equal(local.results[0].albumArtist, "Producer");
    const resolved = await resolveMetadata({ result: local.results[0] });
    assert.equal(resolved.lyrics, "[00:01.25]words");
    assert.equal(resolved.year, 2020);
    const env = { DB: { prepare: () => ({ all: async () => ({ results: [{ key: "scrape_enabled_sources", value: '["lrc"]' }] }) }) } } as unknown as Env;
    calls.length = 0;
    const cloud = await cloudSearch(env, { query: "Song" });
    assert.equal(cloud.results.length, 1);
    assert.equal(calls.length, 1);
    const errors = await searchMetadata({ query: "Song", sources: ["qmusic"] });
    assert.equal(errors.errors[0].source, "qmusic");
    await assert.rejects(searchMetadata({ query: "Song", sources: ["migu"] }), /supported/);
    await assert.rejects(searchMetadata({ query: "Song", sources: [] }), /supported/);
    await assert.rejects(resolveMetadata({ result: { ...local.results[0], songId: "../bad" } }), /invalid songId/);
  } finally { globalThis.fetch = previous; }
});

test("provider requests reject redirects and cancel pending body reads", async () => {
  const previous = globalThis.fetch;
  const controller = new AbortController();
  let aborted = false;
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.redirect, "manual");
    return { ok: true, json: () => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
    }) } as Response;
  };
  try {
    const { proxyFetch } = await import("../../shared/scrape/transport");
    const pending = proxyFetch("lrc", "search", { query: "Song" }, controller.signal);
    await Promise.resolve();
    controller.abort();
    await assert.rejects(pending, /aborted/);
    assert.equal(aborted, true);
  } finally { globalThis.fetch = previous; }
});

test("server provider failures do not launch a browser fallback", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("", { status: 503 }); };
  try {
    const result = await searchMetadata({ query: "Song", sources: ["netease"] });
    assert.equal(calls, 1);
    assert.match(result.errors[0].error, /503/);
  } finally { globalThis.fetch = previous; }
});
