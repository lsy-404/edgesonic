import { test } from "node:test";
import assert from "node:assert/strict";
import { OAuthStore } from "../../worker/src/mcp/oauthStore";
import { sqliteD1 } from "./mcp_test_db";

test("OAuth storage isolates keys, expires entries and paginates with metadata", async () => {
  const { sqlite, db } = sqliteD1();
  const store = new OAuthStore(db);
  await Promise.all(Array.from({ length: 5 }, (_, i) => store.put(`grant:user:${i}`, JSON.stringify({ i }), { metadata: { i } })));
  await store.put("grant:user:expired", "old", { expiration: Math.floor(Date.now() / 1000) - 1 });
  await store.put("grant:other:1", "other");
  sqlite.exec("INSERT INTO kv_store VALUES ('unrelated', 'keep', 0)");
  assert.equal(await store.get("grant:user:expired"), null);
  assert.deepEqual(await store.get("grant:user:2", { type: "json" }), { i: 2 });
  const first = await store.list({ prefix: "grant:user:", limit: 2 });
  assert.equal(first.list_complete, false);
  assert.deepEqual(first.keys.map(k => k.name), ["grant:user:0", "grant:user:1"]);
  assert.deepEqual(first.keys[0].metadata, { i: 0 });
  const second = await store.list({ prefix: "grant:user:", limit: 2, cursor: first.cursor });
  const third = await store.list({ prefix: "grant:user:", limit: 2, cursor: second.cursor });
  assert.deepEqual([...second.keys, ...third.keys].map(k => k.name), ["grant:user:2", "grant:user:3", "grant:user:4"]);
  assert.equal(third.list_complete, true);
  await assert.rejects(store.list({ prefix: "grant:other:", cursor: first.cursor }));
  await store.delete("grant:user:2");
  assert.equal(await store.get("grant:user:2"), null);
  assert.equal(sqlite.prepare("SELECT value FROM kv_store WHERE key = 'unrelated'").get()?.value, "keep");
});
