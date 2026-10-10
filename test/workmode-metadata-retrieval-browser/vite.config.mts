import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Hono } from "hono";
import { defineConfig, type Plugin } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const repository = resolve(root, "../..");
const serverRepository = resolve(process.env.WORKMODE_SERVER_SOURCE_ROOT || repository);
const events: Array<{ type: string; body: Record<string, unknown> }> = [];
const song = {
  id: 724001,
  name: "Fixture Song",
  artists: [{ name: "Fixture Artist" }],
  album: { name: "Fixture Album", artists: [{ name: "Fixture Artist" }], publishTime: 1_704_067_200_000 },
};
let sqlite: DatabaseSync | undefined;
let app: Hono | undefined;
let env: Env | undefined;
let loading: Promise<void> | undefined;
let lastSubmission: Record<string, unknown> | undefined;

function json(res: any, body: unknown, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJson(req: any): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function d1(database: DatabaseSync) {
  return {
    prepare(query: string) {
      const statement = database.prepare(query);
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) { args = values; return this; },
        async first<T>() { return (statement.get(...args) ?? null) as T | null; },
        async all<T>() { return { results: statement.all(...args) as T[], success: true, meta: {} }; },
        async run() {
          const info = statement.run(...args);
          return { success: true, meta: { changes: Number(info.changes ?? 0) } };
        },
      };
    },
    async batch(statements: Array<{ run(): Promise<{ meta: { changes: number } }> }>) {
      database.exec("BEGIN");
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

async function ensureServer(viteServer: any) {
  if (app && sqlite && env) return;
  if (loading) return loading;
  loading = (async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(readFileSync(resolve(repository, "worker/migrations/Schema.sql"), "utf8"));
    database.exec(`
      INSERT INTO users (username, master_password, level) VALUES ('fixture-admin', 'fixture', 3);
      INSERT INTO storage_sources (id, type, name, base_url, enabled) VALUES ('fixture-source', 'r2', 'Local fixture', '', 1);
      INSERT INTO artists (id, name, sort_name) VALUES
        ('fixture-unknown-artist', 'Unknown Artist', 'unknown artist'),
        ('fixture-known-artist', 'Fixture Artist', 'fixture artist');
      INSERT INTO albums (id, name, sort_name) VALUES ('fixture-pending-album', 'Pending Uploads', 'pending uploads');
      INSERT INTO song_masters (id, album_id, artist_id, title, sort_title, lyrics, updated_at)
        VALUES ('fixture-master', 'fixture-pending-album', 'fixture-unknown-artist', 'Fixture Song', 'fixture song', NULL, 100);
      INSERT INTO storage_objects (id, physical_key, suffix, size) VALUES ('fixture-object', 'fixture-object.mp3', 'mp3', 0);
      INSERT INTO song_instances (id, master_id, source_id, source_type, storage_uri, suffix, missing, source_etag, created_at)
        VALUES ('fixture-instance', 'fixture-master', 'fixture-source', 'original', 'r2://fixture/fixture-object.mp3', 'mp3', 0, 'fixture-etag', 1);
      INSERT INTO storage_entries (id, source_id, path, display_name, kind, object_id, instance_id)
        VALUES ('fixture-entry', 'fixture-source', 'Fixture Artist/专辑/Fixture Album/01 Fixture Song.mp3', '01 Fixture Song.mp3', 'file', 'fixture-object', 'fixture-instance');
      UPDATE feature_strings SET value='["netease"]' WHERE key='scrape_enabled_sources';
    `);
    const server = new Hono();
    server.use("*", async (c: any, next: () => Promise<void>) => {
      c.set("user", { username: "fixture-admin", level: 3 });
      c.set("authMethod", "session");
      await next();
    });
    const loaded = await viteServer.ssrLoadModule(resolve(serverRepository, "worker/src/endpoints/edgesonic/work.ts"));
    server.route("/edgesonic", loaded.workRoutes);
    sqlite = database;
    env = { DB: d1(database), MUSIC_BUCKET: { async put() {}, async delete() {} } } as unknown as Env;
    app = server;
  })().finally(() => { loading = undefined; });
  return loading;
}

async function callRoute(path: string, body: unknown, viteServer: any) {
  await ensureServer(viteServer);
  const response = await app!.fetch(new Request(`http://fixture${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), env);
  return { response, body: await response.json() as Record<string, unknown> };
}

async function resetFixture(viteServer: any) {
  sqlite?.close();
  app = undefined;
  sqlite = undefined;
  env = undefined;
  lastSubmission = undefined;
  events.length = 0;
  loading = undefined;
  await ensureServer(viteServer);
}

const fixturePlugin: Plugin = {
  name: "workmode-metadata-retrieval-loopback-fixture",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const path = (req.url || "").split("?", 1)[0];
      try {
        if (req.method === "POST" && path === "/fixture/reset") {
          await resetFixture(server);
          return json(res, { ok: true });
        }
        if (req.method === "POST" && path === "/fixture/dispatch") {
          const { response, body } = await callRoute("/edgesonic/work/scrape/dispatch", {}, server);
          if (!response.ok) return json(res, body, response.status);
          const row = sqlite!.prepare("SELECT id, payload FROM work_queue WHERE id='wt-scrape-retrieve:fixture-master'").get() as { id: string; payload: string } | undefined;
          if (!row) return json(res, { ok: false, error: "dispatch created no fixture task", dispatch: body }, 500);
          const claimedAt = Math.floor(Date.now() / 1000);
          sqlite!.prepare("UPDATE work_queue SET status='claimed', claimed_by='fixture-admin', claimed_at=?, heartbeat_at=?, attempts=1 WHERE id=? AND status='queued'")
            .run(claimedAt, claimedAt, row.id);
          const queue = sqlite!.prepare("SELECT attempts, max_attempts, priority, required_caps FROM work_queue WHERE id=?").get(row.id) as any;
          return json(res, {
            ok: true,
            task: {
              id: row.id, taskType: "scrape", payload: JSON.parse(row.payload),
              requiredCaps: queue.required_caps ? JSON.parse(queue.required_caps) : [],
              priority: queue.priority, attempts: queue.attempts, maxAttempts: queue.max_attempts,
              claimedAt, heartbeatAt: claimedAt,
            },
            dispatch: body,
            claim: "fixture coordinator simulation",
          });
        }
        if (req.method === "GET" && path === "/fixture/report") {
          await ensureServer(server);
          const intents = events.filter((event) => event.type === "proxy").map((event) => event.body.intent);
          const result = lastSubmission?.result as Record<string, unknown> | undefined;
          const match = result?.match as Record<string, unknown> | undefined;
          const catalog = sqlite!.prepare(`SELECT sm.id, sm.title, sm.lyrics, sm.album_id, ar.name AS artist,
            a.name AS album, a.year FROM song_masters sm JOIN artists ar ON ar.id=sm.artist_id
            JOIN albums a ON a.id=sm.album_id WHERE sm.id='fixture-master'`).get() as Record<string, unknown>;
          const queue = sqlite!.prepare("SELECT status, error_message, result_json FROM work_queue WHERE id='wt-scrape-retrieve:fixture-master'").get() as Record<string, unknown> | undefined;
          const protocol = {
            search: intents.includes("search"), detail: intents.includes("detail"), lyric: intents.includes("lyric"),
            submit: !!lastSubmission,
            applied: (lastSubmission?.applied as Record<string, unknown> | undefined)?.ok === true,
          };
          return json(res, {
            provider: "local fixture only",
            storage: "in-memory SQLite D1 shim seeded from worker/migrations/Schema.sql; no R2 writes",
            protocol,
            events,
            submission: lastSubmission ? {
              accepted: true,
              id: lastSubmission.id,
              attempts: lastSubmission.attempts,
              applied: lastSubmission.applied,
              result: {
                kind: result?.kind, status: result?.status,
                match: match ? { source: match.source, songId: match.songId, title: match.title,
                  artist: match.artist, album: match.album, year: match.year, lyrics: match.lyrics } : undefined,
              },
            } : undefined,
            queue,
            catalogReadback: catalog,
            complete: protocol.search && protocol.detail && protocol.lyric && protocol.submit && protocol.applied &&
              catalog.artist === "Fixture Artist" && catalog.album === "Fixture Album" && catalog.lyrics === "[00:01.200]Fixture lyric line",
          });
        }
        if (req.method === "POST" && path === "/tag/scrape") {
          const body = await readJson(req);
          if (body.source !== "netease") return json(res, { ok: false, error: "only the local NetEase fixture is enabled" }, 400);
          events.push({ type: "proxy", body });
          if (body.intent === "search") return json(res, { ok: true, source: "netease", intent: "search", data: { result: { songs: [song] } } });
          if (body.intent === "detail") return json(res, { ok: true, source: "netease", intent: "detail", data: { songs: [song] } });
          if (body.intent === "lyric") return json(res, { ok: true, source: "netease", intent: "lyric", data: { lrc: { lyric: JSON.stringify([{ t: 1200, c: [{ tx: "Fixture lyric line" }] }]) } } });
          return json(res, { ok: false, error: "unsupported fixture intent" }, 400);
        }
        if (req.method === "POST" && (path === "/fixture/work/heartbeat" || path === "/fixture/work/submit")) {
          const body = await readJson(req);
          const route = path.endsWith("heartbeat") ? "heartbeat" : "submit";
          const { response, body: routeBody } = await callRoute(`/edgesonic/work/${route}`, body, server);
          if (route === "submit") lastSubmission = { ...body, ...routeBody };
          events.push({ type: route, body: routeBody });
          return json(res, routeBody, response.status);
        }
        next();
      } catch (error) {
        json(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
      }
    });
  },
};

export default defineConfig({
  root,
  plugins: [fixturePlugin],
  server: { host: "127.0.0.1", port: 4181, strictPort: true, fs: { allow: [resolve(repository, ".."), repository, serverRepository] } },
});
