// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { albumDisplayGroupRoutes } from "../../worker/src/endpoints/edgesonic/albumDisplayGroups";

function d1(sqlite: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) { args = values; return this; },
        async first<T = unknown>() { return (statement.get(...args) ?? null) as T | null; },
        async all<T = unknown>() { return { results: statement.all(...args) as T[] }; },
        async run() { return { success: true, meta: { changes: Number(statement.run(...args).changes ?? 0) } }; },
      } as unknown as D1PreparedStatement;
    },
  } as D1Database;
}

function buildDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE albums (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, year INTEGER,
      cover_r2_key TEXT, song_count INTEGER DEFAULT 0, created_at INTEGER DEFAULT 1
    );
    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE song_masters (
      id TEXT PRIMARY KEY, album_id TEXT NOT NULL, artist_id TEXT NOT NULL,
      title TEXT NOT NULL, track INTEGER,
      FOREIGN KEY (album_id) REFERENCES albums(id)
    );
  `);
  const albums = [
    "al-a1", "al-a2", "al-a3", "al-a4",
    "al-b1", "al-b2", "al-b3", "al-b4", "al-b5",
  ];
  sqlite.prepare("INSERT INTO artists(id, name) VALUES ('ar-1', 'Artist')").run();
  const addAlbum = sqlite.prepare("INSERT INTO albums(id,name,sort_name,year,cover_r2_key,song_count,created_at) VALUES (?,?,?,2024,?,1,1)");
  const addSong = sqlite.prepare("INSERT INTO song_masters(id,album_id,artist_id,title,track) VALUES (?,?, 'ar-1', ?,1)");
  for (const [index, id] of albums.entries()) {
    addAlbum.run(id, `Edition ${index + 1}`, `edition ${index + 1}`, `covers/${id}`);
    addSong.run(`sm-${index + 1}`, id, `Track ${index + 1}`);
  }
  sqlite.exec(readFileSync(new URL("../../worker/migrations/0042_album_display_groups.sql", import.meta.url), "utf8"));
  sqlite.exec(`
    INSERT INTO album_display_groups(id,display_name,sort_name) VALUES
      ('group-a','Group A','group a'), ('group-b','Group B','group b');
    INSERT INTO album_display_group_members(group_id,album_id,sort_order) VALUES
      ('group-a','al-a3',0), ('group-a','al-a1',1), ('group-a','al-a4',2), ('group-a','al-a2',3),
      ('group-b','al-b1',0), ('group-b','al-b2',1), ('group-b','al-b3',2), ('group-b','al-b4',3), ('group-b','al-b5',4);
  `);
  return sqlite;
}

function routeFetch(sqlite: DatabaseSync) {
  const app = new Hono<{ Bindings: { DB: D1Database }; Variables: { user: { level: number } } }>();
  app.use("*", async (c, next) => {
    c.set("user", { level: 3 });
    return next();
  });
  app.route("/edgesonic", albumDisplayGroupRoutes);
  return (path: string) => app.fetch(new Request(`http://test${path}`), { DB: d1(sqlite) });
}

describe("album display groups", () => {
  it("projects curated groups and returns editions with their original album IDs", async () => {
    const sqlite = buildDb();
    const fetch = routeFetch(sqlite);
    const listResponse = await fetch("/edgesonic/album-display-groups");
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json() as { groups: Array<{ id: string; memberAlbumIds: string[]; memberCount: number }> };
    const rain = list.groups.find((group) => group.id === "group-a");
    assert.equal(rain?.memberCount, 4);
    assert.deepEqual(rain?.memberAlbumIds, ["al-a3", "al-a1", "al-a4", "al-a2"]);

    const detailResponse = await fetch("/edgesonic/album-display-groups/group-b");
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json() as { group: { editions: Array<{ id: string; coverArt: string; artist: string }> } };
    assert.equal(detail.group.editions.length, 5);
    assert.equal(detail.group.editions[0].id, "al-b1");
    assert.equal(detail.group.editions[0].coverArt, "al-b1");
    assert.equal(detail.group.editions[0].artist, "Artist");
    sqlite.prepare("INSERT INTO album_display_groups(id,display_name) VALUES ('other','Other')").run();
    assert.throws(() => sqlite.prepare("INSERT INTO album_display_group_members(group_id,album_id) VALUES ('other','al-b1')").run());
    sqlite.close();
  });

  it("hides undersized groups and invalidates all memberships when any member album is pruned", async () => {
    const sqlite = buildDb();
    const fetch = routeFetch(sqlite);
    const missingResponse = await fetch("/edgesonic/album-display-groups/missing");
    assert.equal(missingResponse.status, 404);

    sqlite.prepare("DELETE FROM song_masters WHERE album_id = ?").run("al-a2");
    sqlite.prepare("DELETE FROM albums WHERE id = ?").run("al-a2");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM album_display_groups WHERE id = 'group-a'").get()?.n, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM album_display_group_members WHERE group_id = 'group-a'").get()?.n, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM albums WHERE id LIKE 'al-%'").get()?.n, 8);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM song_masters").get()?.n, 8);
    const listResponse = await fetch("/edgesonic/album-display-groups");
    const list = await listResponse.json() as { groups: Array<{ id: string }> };
    assert.equal(list.groups.some((group) => group.id === "group-a"), false);
    sqlite.close();
  });
});
