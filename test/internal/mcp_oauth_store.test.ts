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

test("revocation prevents stale grant and token writes and hides preexisting tokens", async () => {
  const { db } = sqliteD1();
  const issuer = new OAuthStore(db);
  const refreshing = new OAuthStore(db);
  const revoker = new OAuthStore(db);
  await issuer.put("grant:user:id", JSON.stringify({ refreshTokenId: "old" }));
  await issuer.put("token:user:id:old", "old token");
  assert.deepEqual(await refreshing.get("grant:user:id", "json"), { refreshTokenId: "old" });
  await revoker.delete("grant:user:id");
  await assert.rejects(refreshing.put("grant:user:id", JSON.stringify({ refreshTokenId: "new" })));
  await assert.rejects(refreshing.put("token:user:id:new", "new token"));
  assert.equal(await issuer.get("token:user:id:old"), null);
  assert.equal(await issuer.get("grant:user:id"), null);
  await assert.rejects(new OAuthStore(db).put("grant:user:id", "replacement"));
  await issuer.put("grant:user:other", "other grant");
  await issuer.put("token:user:other:one", "one");
  await issuer.delete("token:user:other:one");
  await issuer.put("token:user:other:two", "two");
  assert.equal(await issuer.get("token:user:other:two"), "two");
});

test("concurrent grant updates permit only the first writer", async () => {
  const { db } = sqliteD1();
  await new OAuthStore(db).put("grant:user:id", JSON.stringify({ authCodeWrappedKey: "key" }));
  const first = new OAuthStore(db);
  const second = new OAuthStore(db);
  await Promise.all([first.get("grant:user:id"), second.get("grant:user:id")]);
  await first.put("grant:user:id", JSON.stringify({ refreshTokenId: "first" }));
  await assert.rejects(second.put("grant:user:id", JSON.stringify({ refreshTokenId: "second" })));
  assert.deepEqual(await new OAuthStore(db).get("grant:user:id", "json"), { refreshTokenId: "first" });
});
