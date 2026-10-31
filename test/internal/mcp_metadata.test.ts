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
