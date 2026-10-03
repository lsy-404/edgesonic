// SPDX-License-Identifier: AGPL-3.0-or-later
// Run: npx tsx test/subsonic/album_listening_auth.test.ts

import { Hono } from "hono";
import { authMiddleware } from "../../worker/src/auth";
import { subsonicRoutes } from "../../worker/src/endpoints/subsonic";
import { md5 } from "../../worker/src/utils/md5";
import { createDb, makeD1 } from "../helpers/albumListeningDb";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sqlite = createDb();
const password = "client-secret";
async function main() {
try {
  sqlite.exec(`
    INSERT INTO users (username, master_password, level, enabled, activation_status) VALUES
      ('listener', 'unused-master-secret', 1, 1, 'permanent'),
      ('unissued', 'unused-master-secret', 1, 1, 'permanent');
    INSERT OR REPLACE INTO user_permissions (level, permission, enabled, max_rph)
      VALUES (1, 'edit_annotations', 1, 0);
    INSERT INTO subsonic_credentials (id, username, password, label)
      VALUES ('phone-credential', 'listener', 'client-secret', 'Phone');
    INSERT INTO artists (id, name, sort_name) VALUES ('artist', 'Artist', 'artist');
    INSERT INTO albums (id, name, sort_name, created_at) VALUES
      ('album-a', 'Album A', 'album a', 100),
      ('album-b', 'Album B', 'album b', 200);
    INSERT INTO song_masters (id, album_id, artist_id, title, sort_title) VALUES
      ('song-a1', 'album-a', 'artist', 'A1', 'a1'),
      ('song-a2', 'album-a', 'artist', 'A2', 'a2'),
      ('song-b1', 'album-b', 'artist', 'B1', 'b1');
    INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix) VALUES
      ('instance-a1', 'song-a1', 'local', 'r2://a1.flac', 'flac'),
      ('instance-a2', 'song-a2', 'local', 'r2://a2.flac', 'flac'),
      ('instance-b1', 'song-b1', 'local', 'r2://b1.flac', 'flac');
  `);

  const app = new Hono<{ Bindings: Env; Variables: Record<string, unknown> }>();
  app.use("/rest/*", authMiddleware);
  app.route("/rest", subsonicRoutes);
  const env = {
    DB: makeD1(sqlite),
    SSO_MODE: "disabled",
    INSTANCE_ID: "test-instance",
    MAX_PROXY_DEPTH: "3",
    KV: { get: async () => null, put: async () => {}, delete: async () => {} },
  } as unknown as Env;
  const hit = async (query: URLSearchParams) => {
    const endpoint = query.get("endpoint");
    query.delete("endpoint");
    return app.fetch(new Request(`http://test/rest/${endpoint}?${query.toString()}`), env);
  };
  const annotations = () => sqlite.prepare(
    "SELECT item_id, play_count, play_date FROM annotations WHERE item_type = 'song' ORDER BY item_id",
  ).all() as Array<{ item_id: string; play_count: number; play_date: number }>;
  const ids = (body: string) => Array.from(body.matchAll(/<album\b[^>]*\bid="([^"]+)"/g), (match) => match[1]);

  const missing = await hit(new URLSearchParams({ endpoint: "scrobble.view", u: "listener", id: "song-a1" }));
  assert(missing.status === 401, "unsigned Subsonic client request is rejected");
  const wrongPassword = await hit(new URLSearchParams({ endpoint: "scrobble.view", u: "listener", p: "wrong", id: "song-a1" }));
  assert(wrongPassword.status === 401, "wrong issued-credential password is rejected");
  const unissuedPassword = await hit(new URLSearchParams({ endpoint: "scrobble.view", u: "unissued", p: "not-issued", id: "song-a1" }));
  assert(unissuedPassword.status === 401, "user without an issued client credential is rejected");
  assert(annotations().length === 0, "failed authentication attempts write no play annotations");

  const salt = "phoneSalt";
  const signed = (endpoint: string, fields: Array<[string, string]>, auth: "token" | "password") => {
    const query = new URLSearchParams({ endpoint, u: "listener" });
    if (auth === "token") {
      query.set("t", md5(password + salt));
      query.set("s", salt);
    } else {
      query.set("p", password);
    }
    for (const [key, value] of fields) query.append(key, value);
    return query;
  };

  const nowPlayingOnly = await hit(signed("scrobble.view", [
    ["id", "song-a1"], ["id", "song-b1"],
    ["time", "100000"], ["time", "500000"], ["submission", "false"], ["c", "Phone"],
  ], "token"));
  assert(nowPlayingOnly.status === 200, "token/salt client auth reaches scrobble.view");
  assert(annotations().length === 0, "submission=false does not record completed plays");

  const batch = await hit(signed("scrobble.view", [
    ["id", "song-a1"], ["id", "song-a2"],
    ["time", "100000"], ["time", "200000"], ["submission", "true"], ["c", "Phone"],
  ], "token"));
  assert(batch.status === 200, "token/salt authenticated batch scrobble succeeds");
  const batchRows = annotations();
  assert(batchRows.length === 2 && batchRows[0].play_date === 100 && batchRows[1].play_date === 200,
    "repeated id/time parameters record each song at its matching timestamp");

  const passwordScrobble = await hit(signed("scrobble.view", [
    ["id", "song-a1"], ["id", "song-b1"],
    ["time", "300000"], ["time", "500000"], ["submission", "true"],
  ], "password"));
  assert(passwordScrobble.status === 200, "issued client-password auth reaches scrobble.view");
  const finalRows = annotations();
  assert(finalRows.length === 3, "password-authenticated batch adds both new and repeated song records");
  assert(finalRows.find((row) => row.item_id === "song-a1")?.play_count === 2, "repeat scrobble increments that user's song play count");

  const frequent = await hit(signed("getAlbumList2.view", [["type", "frequent"], ["size", "10"]], "token"));
  const frequentBody = await frequent.text();
  assert(frequent.status === 200 && ids(frequentBody).join(",") === "album-a,album-b", "authenticated frequent album list is ranked from client scrobbles");
  const recent = await hit(signed("getAlbumList2.view", [["type", "recent"], ["size", "10"]], "password"));
  const recentBody = await recent.text();
  assert(recent.status === 200 && ids(recentBody).join(",") === "album-b,album-a", "authenticated recent album list follows client play times");

  console.log("authenticated Subsonic album listening integration: PASS");
} finally {
  sqlite.close();
}
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
