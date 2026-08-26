// SPDX-License-Identifier: AGPL-3.0-or-later

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { maintenanceRoutes } from "../../worker/src/endpoints/edgesonic/maintenance";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

declare global { type D1Database = unknown; type Env = unknown; }

function makeD1(sqlite: DatabaseSync): any {
  function prepare(query: string) {
    const stmt = sqlite.prepare(query);
    let boundArgs: any[] = [];
    return {
      bind(...args: any[]) { boundArgs = args; return this; },
      async first<T = unknown>(): Promise<T | null> { return (stmt.get(...boundArgs) ?? null) as T | null; },
      async all<T = unknown>() { return { results: stmt.all(...boundArgs) as T[], success: true, meta: {} }; },
      async run() {
        const info = stmt.run(...boundArgs);
        return { success: true, meta: { changes: Number(info.changes ?? 0) } };
      },
    };
  }
  return {
    prepare,
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

function buildDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE song_masters (
      id TEXT PRIMARY KEY, title TEXT, artist_id TEXT, album_id TEXT, album_artist_id TEXT,
      cover_r2_key TEXT, sort_title TEXT, track INTEGER, disc INTEGER, duration INTEGER,
      genre TEXT, participants TEXT, lyrics TEXT, lyrics_rich TEXT, created_at INTEGER
    );
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY, master_id TEXT NOT NULL, storage_uri TEXT NOT NULL,
      source_type TEXT, parent_instance_id TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE song_artists (song_id TEXT, artist_id TEXT, position INTEGER, PRIMARY KEY(song_id, artist_id));
    CREATE TABLE annotations (
      user_id TEXT, item_id TEXT, item_type TEXT, play_count INTEGER, play_date INTEGER,
      rating INTEGER, starred INTEGER, starred_at INTEGER, PRIMARY KEY(user_id, item_id, item_type)
    );
    CREATE TABLE bookmarks (
      user_id TEXT, song_master_id TEXT, position_ms INTEGER, comment TEXT,
      created_at INTEGER, updated_at INTEGER, PRIMARY KEY(user_id, song_master_id)
    );
    CREATE TABLE playlist_songs (playlist_id TEXT, song_master_id TEXT, position INTEGER, PRIMARY KEY(playlist_id, position));
    CREATE TABLE share_entries (share_id TEXT, song_master_id TEXT, position INTEGER, PRIMARY KEY(share_id, position));
    CREATE TABLE now_playing (username TEXT PRIMARY KEY, song_id TEXT NOT NULL, started_at INTEGER, client_id TEXT, updated_at INTEGER);
    CREATE TABLE scrape_jobs (id TEXT PRIMARY KEY, song_master_id TEXT);
    CREATE TABLE clone_id_map (source_key TEXT, item_type TEXT, remote_id TEXT, local_id TEXT, updated_at INTEGER, PRIMARY KEY(source_key, item_type, remote_id));
    CREATE TABLE play_queues (user_id TEXT PRIMARY KEY, song_ids TEXT, current_id TEXT, updated_at INTEGER);
    CREATE TABLE transcode_jobs (id TEXT PRIMARY KEY, instance_id TEXT, output_instance_id TEXT);
    CREATE TABLE user_permissions (level INTEGER, permission TEXT, enabled INTEGER, max_rph INTEGER, PRIMARY KEY(level, permission));
    INSERT INTO user_permissions VALUES (3, 'maintenance_cleanup', 1, 0);

    INSERT INTO song_masters VALUES
      ('sm-rich', 'Fireworks', 'artist-rich', 'album-rich', 'artist-rich', 'covers/fireworks', 'fireworks', 1, 1, 300, 'Pop', '["composer"]', 'lyrics', '{"rich":true}', 10),
      ('sm-old', 'Fireworks 2025ver', 'unknown-artist', 'pending-uploads', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 5),
      ('sm-same-title-a', 'Same Title', 'artist-a', 'album-a', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1),
      ('sm-same-title-b', 'Same Title', 'artist-b', 'album-b', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 2);
    INSERT INTO song_instances VALUES
      ('si-rich', 'sm-rich', 'r2://music/fireworks.flac', 'original', NULL, 10, 0),
      ('si-old', 'sm-old', 'r2://music/fireworks.flac', 'original', NULL, 5, 0),
      ('si-old-transcode', 'sm-old', 'r2://music/fireworks.mp3', 'transcoded', 'si-old', 6, 0),
      ('si-title-a', 'sm-same-title-a', 'r2://music/other-a.flac', 'original', NULL, 1, 0),
      ('si-title-b', 'sm-same-title-b', 'r2://music/other-b.flac', 'original', NULL, 2, 0);
    INSERT INTO song_artists VALUES ('sm-old', 'artist-guest', 1);
    INSERT INTO annotations VALUES
      ('alice', 'sm-rich', 'song', 3, 100, 4, 1, 90),
      ('alice', 'sm-old', 'song', 5, 200, 5, 1, 110);
    INSERT INTO bookmarks VALUES
      ('alice', 'sm-rich', 1000, 'old bookmark', 1, 10),
      ('alice', 'sm-old', 2000, 'new bookmark', 2, 20);
    INSERT INTO playlist_songs VALUES ('pl-1', 'sm-old', 0);
    INSERT INTO share_entries VALUES ('share-1', 'sm-old', 0);
    INSERT INTO now_playing VALUES ('alice', 'sm-old', 100, 'desktop', 100);
    INSERT INTO scrape_jobs VALUES ('scrape-1', 'sm-old');
    INSERT INTO clone_id_map VALUES ('peer-1', 'song', 'remote-1', 'sm-old', 0);
    INSERT INTO play_queues VALUES ('alice', '["sm-old","sm-same-title-a"]', 'sm-old', 0);
    INSERT INTO transcode_jobs VALUES ('job-1', 'si-old', 'si-old');
  `);
  return sqlite;
}

function makeApp(sqlite: DatabaseSync) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "admin", level: 3, enabled: 1, password: "x" });
    return next();
  });
  app.route("/edgesonic", maintenanceRoutes);
  return async (apply = false) => app.fetch(new Request("http://test/edgesonic/maintenance/dedupeHistoricalSongs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(apply ? { apply: true } : {}),
  }), { DB: makeD1(sqlite) } as any);
}

async function main() {
  console.log("dry run previews same-URI duplicates without changing D1:");
  {
    const sqlite = buildDb();
    const request = makeApp(sqlite);
    const response = await request();
    const body = await response.json() as any;
    assert(response.status === 200 && body.ok && body.applied === false, "preview returns ok and applied:false");
    assert(body.duplicateMasters === 1 && body.duplicateInstances === 1, "preview finds only the one exact-URI duplicate");
    assert(body.groups[0].survivorMasterId === "sm-rich", "metadata-rich master is selected as survivor");
    assert((sqlite.prepare("SELECT COUNT(*) AS n FROM song_masters").get() as any).n === 4, "preview does not delete masters");
    assert((sqlite.prepare("SELECT COUNT(*) AS n FROM song_instances").get() as any).n === 5, "preview does not delete instances");
  }

  console.log("apply migrates references and leaves storage untouched:");
  {
    const sqlite = buildDb();
    const request = makeApp(sqlite);
    const response = await request(true);
    const body = await response.json() as any;
    assert(response.status === 200 && body.applied === true && body.duplicateMasters === 1, "apply reports the completed group");
    assert(!(sqlite.prepare("SELECT 1 FROM song_masters WHERE id='sm-old'").get()), "duplicate master is deleted");
    assert((sqlite.prepare("SELECT master_id FROM song_instances WHERE id='si-old-transcode'").get() as any).master_id === "sm-rich", "non-duplicate format instance follows survivor");
    assert(!(sqlite.prepare("SELECT 1 FROM song_instances WHERE id='si-old'").get()), "redundant same-object instance row is removed");
    assert((sqlite.prepare("SELECT parent_instance_id FROM song_instances WHERE id='si-old-transcode'").get() as any).parent_instance_id === "si-rich", "instance parent reference is rewritten");
    const job = sqlite.prepare("SELECT instance_id, output_instance_id FROM transcode_jobs WHERE id='job-1'").get() as any;
    assert(job.instance_id === "si-rich" && job.output_instance_id === "si-rich", "transcode references point at retained instance");
    assert((sqlite.prepare("SELECT song_master_id FROM playlist_songs").get() as any).song_master_id === "sm-rich", "playlist reference is migrated");
    assert((sqlite.prepare("SELECT song_master_id FROM share_entries").get() as any).song_master_id === "sm-rich", "share reference is migrated");
    assert((sqlite.prepare("SELECT song_id FROM now_playing WHERE username='alice'").get() as any).song_id === "sm-rich", "active playback reference is migrated");
    assert((sqlite.prepare("SELECT song_master_id FROM scrape_jobs").get() as any).song_master_id === "sm-rich", "scrape history reference is migrated");
    assert((sqlite.prepare("SELECT local_id FROM clone_id_map").get() as any).local_id === "sm-rich", "clone identity map is migrated");
    const annotation = sqlite.prepare("SELECT play_count, play_date, rating, starred FROM annotations WHERE item_id='sm-rich'").get() as any;
    assert(annotation.play_count === 8 && annotation.play_date === 200 && annotation.rating === 4 && annotation.starred === 1, "annotations merge without losing play history or survivor rating");
    const bookmark = sqlite.prepare("SELECT position_ms, comment FROM bookmarks WHERE song_master_id='sm-rich'").get() as any;
    assert(bookmark.position_ms === 2000 && bookmark.comment === "new bookmark", "newer bookmark wins the collision");
    const queue = sqlite.prepare("SELECT song_ids, current_id FROM play_queues WHERE user_id='alice'").get() as any;
    assert(queue.song_ids === '["sm-rich","sm-same-title-a"]' && queue.current_id === "sm-rich", "saved play queue is rewritten");
    assert((sqlite.prepare("SELECT COUNT(*) AS n FROM song_masters WHERE id IN ('sm-same-title-a', 'sm-same-title-b')").get() as any).n === 2, "same title with different storage URIs is protected");
  }

  console.log("second apply is idempotent:");
  {
    const sqlite = buildDb();
    const request = makeApp(sqlite);
    await request(true);
    const second = await request(true);
    const body = await second.json() as any;
    assert(body.duplicateMasters === 0 && body.duplicateInstances === 0 && body.groups.length === 0, "second apply is a no-op");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
