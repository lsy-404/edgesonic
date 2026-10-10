// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { workRoutes } from "../../worker/src/endpoints/edgesonic/work";
import { recoverPendingRetrievalApplies } from "../../worker/src/endpoints/edgesonic/workMetadataRetrieval";

let failures = 0;
function assert(value: unknown, message: string) {
  if (value) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE work_queue (
      id TEXT PRIMARY KEY, task_type TEXT NOT NULL, payload TEXT NOT NULL,
      required_caps TEXT, priority INTEGER DEFAULT 5, status TEXT DEFAULT 'queued',
      claimed_by TEXT, claimed_at INTEGER, heartbeat_at INTEGER, result_json TEXT,
      error_message TEXT, attempts INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 3,
      created_at INTEGER DEFAULT 0, expires_at INTEGER
    );
    CREATE TABLE feature_strings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO feature_strings VALUES ('scrape_enabled_sources', '["lrc","netease","qmusic","kugou"]');
    CREATE TABLE user_permissions (level INTEGER, permission TEXT, enabled INTEGER, max_rph INTEGER, PRIMARY KEY(level, permission));
    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT, sort_name TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, year INTEGER, genre TEXT,
      cover_r2_key TEXT, song_count INTEGER DEFAULT 0, duration INTEGER DEFAULT 0, size INTEGER DEFAULT 0,
      compilation INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE song_masters (id TEXT PRIMARY KEY, album_id TEXT NOT NULL, cover_r2_key TEXT,
      artist_id TEXT NOT NULL, album_artist_id TEXT, title TEXT NOT NULL, sort_title TEXT, track INTEGER,
      disc INTEGER, duration INTEGER, genre TEXT, compilation INTEGER DEFAULT 0, participants TEXT,
      lyrics TEXT, lyrics_rich TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE song_instances (id TEXT PRIMARY KEY, master_id TEXT NOT NULL, source_type TEXT DEFAULT 'original',
      storage_uri TEXT NOT NULL, source_etag TEXT, missing INTEGER DEFAULT 0, suffix TEXT, size INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0, FOREIGN KEY(master_id) REFERENCES song_masters(id));
    CREATE TABLE storage_entries (id TEXT PRIMARY KEY, path TEXT, kind TEXT, instance_id TEXT);
    CREATE TABLE song_artists (song_id TEXT, artist_id TEXT, position INTEGER, PRIMARY KEY(song_id, artist_id));
    INSERT INTO artists VALUES ('ar-unknown', 'Unknown Artist', 'unknown artist', 1, 1);
    INSERT INTO artists VALUES ('ar-known', 'Known Artist', 'known artist', 1, 1);
    INSERT INTO albums (id, name, sort_name, year, cover_r2_key) VALUES
      ('al-pending', 'Pending Uploads', 'pending uploads', NULL, NULL),
      ('al-known', 'Known Record', 'known record', NULL, NULL);
    INSERT INTO song_masters (id, album_id, artist_id, title, sort_title, lyrics, updated_at) VALUES
      ('sg-a', 'al-pending', 'ar-unknown', 'Track A', 'track a', NULL, 100),
      ('sg-b', 'al-pending', 'ar-unknown', 'Track B', 'track b', NULL, 100),
      ('sg-known', 'al-known', 'ar-known', 'Known Track', 'known track', NULL, 100);
    INSERT INTO song_instances (id, master_id, storage_uri, source_etag, suffix, created_at) VALUES
      ('si-a', 'sg-a', 'r2://music/a.flac', 'etag-a', 'flac', 1),
      ('si-b', 'sg-b', 'r2://music/b.flac', 'etag-b', 'flac', 1),
      ('si-known', 'sg-known', 'r2://music/known.flac', 'etag-k', 'flac', 1);
    INSERT INTO storage_entries VALUES
      ('se-a', 'Artist/专辑/Folder A/01 Track A.flac', 'file', 'si-a'),
      ('se-b', 'Artist/专辑/Folder B/01 Track B.flac', 'file', 'si-b'),
      ('se-k', 'Known Record/01 Known Track.flac', 'file', 'si-known');
  `);
  return sqlite;
}

function d1(sqlite: DatabaseSync, beforeBatch?: () => void) {
  return {
    prepare(query: string) {
      const stmt = sqlite.prepare(query);
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) { args = values; return this; },
        async first<T>() { return (stmt.get(...args) ?? null) as T | null; },
        async all<T>() { return { results: stmt.all(...args) as T[], success: true, meta: {} }; },
        async run() {
          const info = stmt.run(...args);
          return { success: true, meta: { changes: Number(info.changes ?? 0) } };
        },
      };
    },
    async batch(statements: Array<{ run(): Promise<{ meta: { changes: number } }> }>) {
      beforeBatch?.();
      sqlite.exec("BEGIN");
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
}

function appFor(sqlite: DatabaseSync, beforeBatch?: () => void) {
  const app = new Hono<{ Bindings: Env; Variables: { user: { username: string; level: number }; authMethod: "session" } }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "admin", level: 3 } as never);
    c.set("authMethod", "session");
    return next();
  });
  app.route("/edgesonic", workRoutes);
  const env = { DB: d1(sqlite, beforeBatch), MUSIC_BUCKET: { async put() {}, async delete() {} } } as unknown as Env;
  return { app, env };
}

async function post(app: Hono, env: Env, url: string, body: unknown) {
  return app.fetch(new Request(`http://test${url}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), env);
}

async function main() {
  console.log("dispatch retrieves only eligible missing masters and leaves active work alone:");
  {
    const sqlite = makeDb();
    const { app, env } = appFor(sqlite);
    const first = await post(app, env, "/edgesonic/work/scrape/dispatch", {});
    const result = await first.json() as { enqueued: number; skipped: number; scanned: number; nextCursor: string | null };
    assert(first.status === 200 && result.enqueued === 3 && result.scanned === 3, "first bounded page enqueues three incomplete masters");
    assert(sqlite.prepare("SELECT COUNT(*) AS n FROM work_queue WHERE status='queued'").get() as { n: number } &&
      (sqlite.prepare("SELECT COUNT(*) AS n FROM work_queue WHERE status='queued'").get() as { n: number }).n === 3,
      "queue rows are durable");
    const payload = JSON.parse((sqlite.prepare("SELECT payload FROM work_queue WHERE id='wt-scrape-retrieve:sg-a'").get() as { payload: string }).payload);
    assert(payload.sourceUri === "r2://music/a.flac" && payload.sourceEtag === "etag-a", "source identity is captured in the task");
    assert(payload.snapshot.albumFolder === "Folder A", "source folder is available as a missing-album anchor");
    await post(app, env, "/edgesonic/work/scrape/dispatch", {});
    assert((sqlite.prepare("SELECT attempts FROM work_queue WHERE id='wt-scrape-retrieve:sg-a'").get() as { attempts: number }).attempts === 0,
      "active queued row is not restarted");
  }

  console.log("terminal retrieval restarts preserve monotonic claim generations:");
  {
    const sqlite = makeDb();
    sqlite.prepare("INSERT INTO work_queue (id, task_type, payload, status, attempts, max_attempts, result_json) VALUES (?, 'scrape', '{}', 'failed', 4, 6, '{}')")
      .run("wt-scrape-retrieve:sg-a");
    const { app, env } = appFor(sqlite);
    const response = await post(app, env, "/edgesonic/work/scrape/dispatch", {});
    const row = sqlite.prepare("SELECT status, attempts, max_attempts FROM work_queue WHERE id='wt-scrape-retrieve:sg-a'").get() as { status: string; attempts: number; max_attempts: number };
    assert(response.status === 200 && row.status === "queued" && row.attempts === 4 && row.max_attempts === 7,
      "retry starts above previous attempt number and retains the prior history");
  }

  console.log("filling an unknown album splits only the target from a shared placeholder:");
  {
    const sqlite = makeDb();
    const { app, env } = appFor(sqlite);
    await post(app, env, "/edgesonic/work/scrape/dispatch", {});
    const id = "wt-scrape-retrieve:sg-a";
    const queued = JSON.parse((sqlite.prepare("SELECT payload FROM work_queue WHERE id=?").get(id) as any).payload);
    sqlite.prepare("UPDATE work_queue SET status='claimed', claimed_by='admin', claimed_at=222, attempts=1 WHERE id=?").run(id);
    const response = await post(app, env, "/edgesonic/work/submit", { id, attempts: 1, claimedAt: 222, result: {
      kind: "metadata-retrieval", masterId: "sg-a", instanceId: "si-a", status: "matched",
      match: { source: "netease", songId: "4", title: "Track A", artist: "Recovered Artist", album: "Folder A", year: 2023 },
    } });
    const body = await response.json() as any;
    const current = sqlite.prepare("SELECT album_id FROM song_masters WHERE id='sg-a'").get() as any;
    const other = sqlite.prepare("SELECT album_id FROM song_masters WHERE id='sg-b'").get() as any;
    assert(body.applied?.ok === true && queued.snapshot.album === "Pending Uploads", "source identity permits filling the placeholder album");
    assert(current.album_id !== "al-pending" && other.album_id === "al-pending", "only the target master is relinked");
    assert((sqlite.prepare("SELECT name FROM albums WHERE id='al-pending'").get() as any).name === "Pending Uploads",
      "shared placeholder album row is preserved");
  }

  console.log("cursor dispatch exhausts a fixed page and pending apply cannot be force-requeued:");
  {
    const sqlite = makeDb();
    sqlite.exec("DELETE FROM song_instances; DELETE FROM song_masters; DELETE FROM storage_entries;");
    const insertMaster = sqlite.prepare("INSERT INTO song_masters (id, album_id, artist_id, title, updated_at) VALUES (?, 'al-known', 'ar-known', ?, 100)");
    const insertInstance = sqlite.prepare("INSERT INTO song_instances (id, master_id, storage_uri, source_etag, suffix) VALUES (?, ?, ?, 'etag', 'flac')");
    for (let i = 0; i < 101; i++) {
      const id = `sg-${String(i).padStart(3, "0")}`;
      insertMaster.run(id, `Track ${i}`);
      insertInstance.run(`si-${i}`, id, `r2://music/${i}.flac`);
    }
    const { app, env } = appFor(sqlite);
    const first = await (await post(app, env, "/edgesonic/work/scrape/dispatch", {})).json() as any;
    const second = await (await post(app, env, "/edgesonic/work/scrape/dispatch", { after: first.nextCursor })).json() as any;
    assert(first.scanned === 100 && first.nextCursor === "sg-099" && second.scanned === 1 && second.nextCursor === null,
      "stable master id cursor advances through a full page and then exhausts");
    sqlite.prepare("UPDATE work_queue SET status='completed', error_message='retrieval_apply:pending' WHERE id='wt-scrape-retrieve:sg-000'").run();
    const forced = await (await post(app, env, "/edgesonic/work/scrape/dispatch", {})).json() as any;
    const pending = sqlite.prepare("SELECT status, error_message FROM work_queue WHERE id='wt-scrape-retrieve:sg-000'").get() as any;
    assert(forced.skipped === 100 && pending.status === "completed" && pending.error_message === "retrieval_apply:pending",
      "force dispatch waits for durable result application to finish");
  }

  console.log("retrieval apply fills missing album metadata without renaming a known release:");
  {
    const sqlite = makeDb();
    sqlite.prepare("UPDATE song_masters SET album_artist_id = NULL WHERE id='sg-known'").run();
    const payload = {
      kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known",
      sourceUri: "r2://music/known.flac", sourceEtag: "etag-k", sources: ["netease"], identity: { title: "Known Track", artist: "Known Artist", album: "Known Record" },
      snapshot: { title: "Known Track", artist: "Known Artist", album: "Known Record", albumArtist: null,
        year: null, lyrics: null, coverR2Key: null, masterUpdatedAt: 100, albumFolder: "Known Record" }, query: "Known Track Known Artist Known Record",
    };
    sqlite.prepare("INSERT INTO work_queue (id, task_type, payload, status, claimed_by, claimed_at, attempts) VALUES (?, 'scrape', ?, 'claimed', 'admin', 123, 1)")
      .run("wt-scrape-retrieve:sg-known", JSON.stringify(payload));
    const { app, env } = appFor(sqlite);
    const response = await post(app, env, "/edgesonic/work/submit", {
      id: "wt-scrape-retrieve:sg-known", attempts: 1, claimedAt: 123,
      result: { kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known",
        status: "matched", match: { source: "netease", songId: "123", title: "Known Track", artist: "Known Artist",
          album: "Known Record", albumArtist: "Album Artist", year: 2024, lyrics: "line one" } },
    });
    const body = await response.json() as { applied?: { ok: boolean } };
    const master = sqlite.prepare("SELECT album_id, album_artist_id, lyrics, title, artist_id FROM song_masters WHERE id='sg-known'").get() as any;
    const album = sqlite.prepare("SELECT name, year FROM albums WHERE id='al-known'").get() as any;
    assert(response.status === 200 && body.applied?.ok === true, `server accepts the exact matched result (${JSON.stringify(body)})`);
    assert(master.album_id === "al-known" && master.title === "Known Track" && master.artist_id === "ar-known", "known catalog identity stays fixed");
    assert(album.name === "Known Record" && album.year === 2024 && master.lyrics === "line one", "missing year and lyrics are filled");
    assert((sqlite.prepare("SELECT name FROM artists WHERE id=?").get(master.album_artist_id) as any)?.name === "Album Artist",
      "missing track album artist is attached to this master");
    const replay = await post(app, env, "/edgesonic/work/submit", { id: "wt-scrape-retrieve:sg-known", attempts: 1, claimedAt: 123,
      result: { kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known", status: "matched",
        match: { source: "netease", songId: "123", title: "Known Track", artist: "Known Artist",
          album: "Known Record", albumArtist: "Album Artist", year: 2024, lyrics: "line one" } } });
    assert((await replay.json() as any).replayed === true, "same completed claim returns an idempotent replay");
  }

  console.log("compilation album artist stays Various Artists while preserving the track singer:");
  {
    const sqlite = makeDb();
    sqlite.prepare("UPDATE albums SET compilation=1 WHERE id='al-known'").run();
    sqlite.prepare("UPDATE song_masters SET album_artist_id=NULL WHERE id='sg-known'").run();
    const payload = { kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known",
      sourceUri: "r2://music/known.flac", sourceEtag: "etag-k", sources: ["netease"],
      identity: { title: "Known Track", artist: "Known Artist", album: "Known Record" },
      snapshot: { title: "Known Track", artist: "Known Artist", album: "Known Record", albumArtist: null,
        year: null, lyrics: null, coverR2Key: null, masterUpdatedAt: 100 }, query: "Known Track Known Artist Known Record" };
    sqlite.prepare("INSERT INTO work_queue (id, task_type, payload, status, claimed_by, claimed_at, attempts) VALUES (?, 'scrape', ?, 'claimed', 'admin', 888, 1)")
      .run("wt-scrape-retrieve:sg-known", JSON.stringify(payload));
    const { app, env } = appFor(sqlite);
    await post(app, env, "/edgesonic/work/submit", { id: "wt-scrape-retrieve:sg-known", attempts: 1, claimedAt: 888,
      result: { kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known", status: "matched",
        match: { source: "netease", songId: "6", title: "Known Track", artist: "Known Artist", album: "Known Record" } } });
    const master = sqlite.prepare("SELECT artist_id, album_artist_id FROM song_masters WHERE id='sg-known'").get() as any;
    const credits = sqlite.prepare("SELECT ar.name FROM song_artists sa JOIN artists ar ON ar.id=sa.artist_id WHERE sa.song_id='sg-known'").all() as any[];
    assert((sqlite.prepare("SELECT name FROM artists WHERE id=?").get(master.album_artist_id) as any)?.name === "Various Artists",
      "compilation album artist uses the shared Various Artists identity");
    assert(master.artist_id === "ar-known" && credits.every((row) => row.name !== "Various Artists"),
      "track singer credits remain separate from the album artist");
  }

  console.log("failed master compare-and-set leaves year and artist links unchanged:");
  {
    const sqlite = makeDb();
    sqlite.prepare("INSERT INTO artists VALUES ('ar-user', 'User Singer', 'user singer', 1, 1)").run();
    sqlite.prepare("UPDATE song_masters SET artist_id='ar-unknown', updated_at=? WHERE id='sg-known'")
      .run(Math.floor(Date.now() / 1000));
    sqlite.prepare("INSERT INTO song_artists VALUES ('sg-known', 'ar-unknown', 0)").run();
    sqlite.exec("CREATE TRIGGER hold_master_update BEFORE UPDATE ON song_masters WHEN NEW.id='sg-known' BEGIN SELECT RAISE(IGNORE); END;");
    const payload = { kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known",
      sourceUri: "r2://music/known.flac", sourceEtag: "etag-k", sources: ["netease"],
      identity: { title: "Known Track", artist: "Unknown Artist", album: "Known Record" },
      snapshot: { title: "Known Track", artist: "Unknown Artist", album: "Known Record", albumArtist: null,
        year: null, lyrics: null, coverR2Key: null, masterUpdatedAt: Math.floor(Date.now() / 1000) }, query: "Known Track Known Record" };
    sqlite.prepare("INSERT INTO work_queue (id, task_type, payload, status, claimed_by, claimed_at, attempts) VALUES (?, 'scrape', ?, 'claimed', 'admin', 889, 1)")
      .run("wt-scrape-retrieve:sg-known", JSON.stringify(payload));
    const { app, env } = appFor(sqlite);
    await post(app, env, "/edgesonic/work/submit", { id: "wt-scrape-retrieve:sg-known", attempts: 1, claimedAt: 889,
      result: { kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known", status: "matched",
        match: { source: "netease", songId: "7", title: "Known Track", artist: "New Singer", album: "Known Record",
          year: 2024, lyrics: "must not write" } } });
    assert((sqlite.prepare("SELECT year FROM albums WHERE id='al-known'").get() as any).year === null,
      "album year waits for the master compare-and-set");
    assert((sqlite.prepare("SELECT lyrics FROM song_masters WHERE id='sg-known'").get() as any).lyrics === null,
      "failed master compare-and-set does not mutate lyrics");
    assert((sqlite.prepare("SELECT artist_id FROM song_masters WHERE id='sg-known'").get() as any).artist_id === "ar-unknown",
      "failed master compare-and-set preserves the concurrent singer edit");
    assert((sqlite.prepare("SELECT artist_id FROM song_artists WHERE song_id='sg-known'").get() as any).artist_id === "ar-unknown",
      "song artist links are gated by the catalog receipt");
    assert(!(sqlite.prepare("SELECT error_message FROM work_queue WHERE id='wt-scrape-retrieve:sg-known'").get() as any).error_message?.startsWith("retrieval_apply:catalog:"),
      "a failed compare-and-set cannot create a catalog receipt");
  }

  console.log("artist edits and a replaced apply lease fence catalog writes:");
  for (const change of ["artist", "lease"] as const) {
    const sqlite = makeDb();
    const payload = { kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known",
      sourceUri: "r2://music/known.flac", sourceEtag: "etag-k", sources: ["netease"],
      identity: { title: "Known Track", artist: "Known Artist", album: "Known Record" },
      snapshot: { title: "Known Track", artist: "Known Artist", album: "Known Record", albumArtist: null,
        year: null, lyrics: null, coverR2Key: null, masterUpdatedAt: 100 }, query: "Known Track" };
    const id = "wt-scrape-retrieve:sg-known";
    sqlite.prepare("INSERT INTO work_queue (id, task_type, payload, status, claimed_by, claimed_at, attempts) VALUES (?, 'scrape', ?, 'claimed', 'admin', 444, 1)")
      .run(id, JSON.stringify(payload));
    const { app, env } = appFor(sqlite, () => {
      if (change === "artist") sqlite.prepare("UPDATE artists SET name='Manual Artist' WHERE id='ar-known'").run();
      else sqlite.prepare("UPDATE work_queue SET error_message='retrieval_apply:applying:other-owner' WHERE id=?").run(id);
    });
    const response = await post(app, env, "/edgesonic/work/submit", { id, attempts: 1, claimedAt: 444, result: {
      kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known", status: "matched",
      match: { source: "netease", songId: "7", title: "Known Track", artist: "Known Artist", album: "Known Record", year: 2024, lyrics: "provider lyrics" },
    } });
    const body = await response.json() as { applied?: { ok: boolean } };
    assert(body.applied?.ok === false, `${change} mutation prevents the stale catalog apply`);
    assert((sqlite.prepare("SELECT lyrics FROM song_masters WHERE id='sg-known'").get() as any).lyrics === null,
      `${change} mutation leaves lyrics unchanged`);
    assert((sqlite.prepare("SELECT year FROM albums WHERE id='al-known'").get() as any).year === null,
      `${change} mutation leaves album year unchanged`);
    if (change === "lease") assert((sqlite.prepare("SELECT error_message FROM work_queue WHERE id=?").get(id) as any).error_message === "retrieval_apply:applying:other-owner",
      "stale finalization does not clear another owner's lease");
  }

  console.log("stale source and ambiguous matches are recorded without catalog edits:");
  {
    const sqlite = makeDb();
    const payload = {
      kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known", sourceUri: "r2://music/known.flac",
      sourceEtag: "old-etag", sources: ["netease"], identity: { title: "Known Track", artist: "Known Artist", album: "Known Record" }, snapshot: { title: "Known Track", artist: "Known Artist",
        album: "Known Record", albumArtist: null, year: null, lyrics: null, coverR2Key: null, masterUpdatedAt: 100 }, query: "Known Track",
    };
    sqlite.prepare("UPDATE song_masters SET album_artist_id = NULL WHERE id='sg-known'").run();
    sqlite.prepare("UPDATE song_instances SET source_etag='new-etag' WHERE id='si-known'").run();
    sqlite.prepare("INSERT INTO work_queue (id, task_type, payload, status, claimed_by, claimed_at, attempts) VALUES (?, 'scrape', ?, 'claimed', 'admin', 123, 1)")
      .run("wt-scrape-retrieve:sg-known", JSON.stringify(payload));
    const { app, env } = appFor(sqlite);
    const response = await post(app, env, "/edgesonic/work/submit", { id: "wt-scrape-retrieve:sg-known", attempts: 1, claimedAt: 123, result: {
      kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known", status: "matched",
      match: { source: "netease", songId: "1", title: "Known Track", artist: "Known Artist", album: "Known Record" },
    } });
    const body = await response.json() as { applied?: { ok: boolean } };
    assert(body.applied?.ok === false, `stale source snapshot rejects application (${JSON.stringify(body)})`);
    assert((sqlite.prepare("SELECT album_id, title FROM song_masters WHERE id='sg-known'").get() as any).title === "Known Track",
      "stale or ambiguous match cannot alter the master");
  }

  console.log("known album and artist constraints must both agree with derived identity hints:");
  {
    const sqlite = makeDb();
    const payload = {
      kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known", sourceUri: "r2://music/known.flac",
      sourceEtag: "etag-k", sources: ["netease"], identity: { title: "Known Track", artist: "Known Artist", album: "Wrong Folder" },
      snapshot: { title: "Known Track", artist: "Known Artist", album: "Known Record", albumArtist: null,
        year: null, lyrics: null, coverR2Key: null, masterUpdatedAt: 100, albumFolder: "Wrong Folder" }, query: "Known Track Known Artist Wrong Folder",
    };
    sqlite.prepare("INSERT INTO work_queue (id, task_type, payload, status, claimed_by, claimed_at, attempts) VALUES (?, 'scrape', ?, 'claimed', 'admin', 456, 1)")
      .run("wt-scrape-retrieve:sg-known", JSON.stringify(payload));
    const { app, env } = appFor(sqlite);
    const response = await post(app, env, "/edgesonic/work/submit", { id: "wt-scrape-retrieve:sg-known", attempts: 1, claimedAt: 456, result: {
      kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known", status: "matched",
      match: { source: "netease", songId: "2", title: "Known Track", artist: "Known Artist", album: "Wrong Folder" },
    } });
    const body = await response.json() as { applied?: { ok: boolean } };
    assert(response.status === 400 && !body.applied, "known raw album snapshot rejects a conflicting folder hint");
    assert((sqlite.prepare("SELECT album_id, title FROM song_masters WHERE id='sg-known'").get() as any).album_id === "al-known",
      "conflicting album identity keeps the existing album link");
  }

  console.log("a no-match result completes durably without changing catalog metadata:");
  {
    const sqlite = makeDb();
    const payload = { kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known",
      sourceUri: "r2://music/known.flac", sourceEtag: "etag-k", sources: ["netease"], identity: { title: "Known Track", artist: "Known Artist", album: "Known Record" },
      snapshot: { title: "Known Track", artist: "Known Artist", album: "Known Record", albumArtist: null,
        year: null, lyrics: null, coverR2Key: null, masterUpdatedAt: 100 }, query: "Known Track" };
    sqlite.prepare("INSERT INTO work_queue (id, task_type, payload, status, claimed_by, claimed_at, attempts) VALUES (?, 'scrape', ?, 'claimed', 'admin', 789, 1)")
      .run("wt-scrape-retrieve:sg-known", JSON.stringify(payload));
    const { app, env } = appFor(sqlite);
    const response = await post(app, env, "/edgesonic/work/submit", { id: "wt-scrape-retrieve:sg-known", attempts: 1, claimedAt: 789, result: {
      kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known", status: "no-match", reason: "No exact result",
    } });
    const body = await response.json() as { applied?: { ok: boolean } };
    assert(body.applied?.ok === true, "no-match is a successful completed retrieval");
    assert((sqlite.prepare("SELECT lyrics FROM song_masters WHERE id='sg-known'").get() as any).lyrics === null,
      "no-match does not alter the catalog");
  }

  console.log("scheduled recovery finishes an atomic catalog receipt without replaying its old snapshot:");
  {
    const sqlite = makeDb();
    sqlite.prepare("UPDATE song_masters SET lyrics='already applied', updated_at=200 WHERE id='sg-known'").run();
    const payload = { kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known",
      sourceUri: "r2://music/known.flac", sourceEtag: "etag-k", sources: ["netease"],
      identity: { title: "Known Track", artist: "Known Artist", album: "Known Record" },
      snapshot: { title: "Known Track", artist: "Known Artist", album: "Known Record", albumArtist: null,
        year: null, lyrics: null, coverR2Key: null, masterUpdatedAt: 100 }, query: "Known Track" };
    const result = { kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known", status: "matched",
      match: { source: "netease", songId: "4", title: "Known Track", artist: "Known Artist", album: "Known Record" },
      cover: { data: "R0lGODlh", mime: "image/gif" } };
    sqlite.prepare(`INSERT INTO work_queue (id, task_type, payload, status, result_json, error_message, heartbeat_at)
      VALUES (?, 'scrape', ?, 'completed', ?, 'retrieval_apply:catalog:al-known:cover', 1)`)
      .run("wt-scrape-retrieve:sg-known", JSON.stringify(payload), JSON.stringify(result));
    const { env } = appFor(sqlite);
    assert(await recoverPendingRetrievalApplies(env) === 1, "catalog receipt is recovered");
    assert(!!(sqlite.prepare("SELECT cover_r2_key FROM albums WHERE id='al-known'").get() as any).cover_r2_key,
      "recovery attaches cover to the receipt album despite the old snapshot");
    assert((sqlite.prepare("SELECT error_message FROM work_queue WHERE id='wt-scrape-retrieve:sg-known'").get() as any).error_message === null,
      "catalog receipt is cleared after cover completion");
  }

  console.log("invalid covers are ignored terminally after catalog metadata is applied:");
  {
    const sqlite = makeDb();
    const payload = { kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known",
      sourceUri: "r2://music/known.flac", sourceEtag: "etag-k", sources: ["netease"],
      identity: { title: "Known Track", artist: "Known Artist", album: "Known Record" },
      snapshot: { title: "Known Track", artist: "Known Artist", album: "Known Record", albumArtist: null,
        year: null, lyrics: null, coverR2Key: null, masterUpdatedAt: 100 }, query: "Known Track" };
    const result = { kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known", status: "matched",
      match: { source: "netease", songId: "8", title: "Known Track", artist: "Known Artist", album: "Known Record", lyrics: "saved" },
      cover: { data: "PHN2Zz48L3N2Zz4=", mime: "image/svg+xml" } };
    sqlite.prepare("INSERT INTO work_queue (id, task_type, payload, status, claimed_by, claimed_at, attempts) VALUES (?, 'scrape', ?, 'claimed', 'admin', 890, 1)")
      .run("wt-scrape-retrieve:sg-known", JSON.stringify(payload));
    const { app, env } = appFor(sqlite);
    const response = await post(app, env, "/edgesonic/work/submit", { id: "wt-scrape-retrieve:sg-known", attempts: 1, claimedAt: 890, result });
    const body = await response.json() as { applied?: { ok: boolean; reason?: string } };
    assert(body.applied?.ok === true && body.applied.reason === "invalid cover ignored",
      `invalid cover data does not retry or strand the matched result (${JSON.stringify(body)})`);
    assert((sqlite.prepare("SELECT lyrics FROM song_masters WHERE id='sg-known'").get() as any).lyrics === "saved",
      "metadata fields remain applied when an untrusted cover is ignored");
    assert((sqlite.prepare("SELECT error_message FROM work_queue WHERE id='wt-scrape-retrieve:sg-known'").get() as any).error_message === null,
      "invalid cover marker is cleared terminally");
  }

  console.log("scheduled recovery clears a no-cover catalog receipt without repeating catalog writes:");
  {
    const sqlite = makeDb();
    sqlite.prepare("UPDATE song_masters SET lyrics='already applied', updated_at=200 WHERE id='sg-known'").run();
    const payload = { kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known",
      sourceUri: "r2://music/known.flac", sourceEtag: "etag-k", sources: ["netease"],
      identity: { title: "Known Track", artist: "Known Artist", album: "Known Record" },
      snapshot: { title: "Known Track", artist: "Known Artist", album: "Known Record", albumArtist: null,
        year: null, lyrics: null, coverR2Key: null, masterUpdatedAt: 100 }, query: "Known Track" };
    const result = { kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known", status: "matched",
      match: { source: "netease", songId: "5", title: "Known Track", artist: "Known Artist", album: "Known Record" } };
    sqlite.prepare(`INSERT INTO work_queue (id, task_type, payload, status, result_json, error_message, heartbeat_at)
      VALUES (?, 'scrape', ?, 'completed', ?, 'retrieval_apply:catalog:al-known:done', 1)`)
      .run("wt-scrape-retrieve:sg-known", JSON.stringify(payload), JSON.stringify(result));
    const { env } = appFor(sqlite);
    assert(await recoverPendingRetrievalApplies(env) === 1, "no-cover receipt is recovered");
    assert((sqlite.prepare("SELECT lyrics FROM song_masters WHERE id='sg-known'").get() as any).lyrics === "already applied",
      "recovery leaves already applied catalog fields unchanged");
    assert((sqlite.prepare("SELECT error_message FROM work_queue WHERE id='wt-scrape-retrieve:sg-known'").get() as any).error_message === null,
      "no-cover receipt is cleared");
  }

  console.log("scheduled recovery replays a saved result after a completed-task interruption:");
  {
    const sqlite = makeDb();
    const payload = { kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known",
      sourceUri: "r2://music/known.flac", sourceEtag: "etag-k", sources: ["netease"], identity: { title: "Known Track", artist: "Known Artist", album: "Known Record" },
      snapshot: { title: "Known Track", artist: "Known Artist", album: "Known Record", albumArtist: null,
        year: null, lyrics: null, coverR2Key: null, masterUpdatedAt: 100 }, query: "Known Track" };
    const result = { kind: "metadata-retrieval", masterId: "sg-known", instanceId: "si-known", status: "matched",
      match: { source: "netease", songId: "3", title: "Known Track", artist: "Known Artist", album: "Known Record", lyrics: "recovered" } };
    sqlite.prepare(`INSERT INTO work_queue (id, task_type, payload, status, claimed_by, claimed_at, attempts,
      result_json, error_message, heartbeat_at) VALUES (?, 'scrape', ?, 'completed', 'admin', 1, 1, ?, 'retrieval_apply:pending', 1)`)
      .run("wt-scrape-retrieve:sg-known", JSON.stringify(payload), JSON.stringify(result));
    const { env } = appFor(sqlite);
    const recovered = await recoverPendingRetrievalApplies(env);
    assert(recovered === 1, "scheduled recovery scans one pending apply");
    assert((sqlite.prepare("SELECT lyrics FROM song_masters WHERE id='sg-known'").get() as any).lyrics === "recovered",
      "saved retrieval result is applied");
    assert((sqlite.prepare("SELECT error_message FROM work_queue WHERE id='wt-scrape-retrieve:sg-known'").get() as any).error_message === null,
      "successful replay clears the apply marker");
  }

  if (failures) throw new Error(`${failures} retrieval assertions failed`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
