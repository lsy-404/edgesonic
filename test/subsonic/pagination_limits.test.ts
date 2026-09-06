import { Hono } from "hono";
import { browsingRoutes } from "../../worker/src/endpoints/subsonic/browsing";
import { podcastsRoutes } from "../../worker/src/endpoints/subsonic/podcasts";
import { searchRoutes } from "../../worker/src/endpoints/subsonic/searching";
import { MAX_PAGE_OFFSET, MAX_PAGE_SIZE } from "../../worker/src/endpoints/subsonic/pagination";

declare global { type D1Database = unknown; }

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

interface Call { sql: string; binds: unknown[]; }

function makeDb() {
  const calls: Call[] = [];
  return {
    calls,
    prepare(sql: string) {
      const statement = {
        bind(...binds: unknown[]) {
          return {
            async all() { calls.push({ sql, binds }); return { results: [] }; },
            async first() { calls.push({ sql, binds }); return null; },
            async run() { calls.push({ sql, binds }); return { meta: { changes: 0 } }; },
          };
        },
      };
      return statement;
    },
  };
}

function makeApp(routes: Hono<any>) {
  const db = makeDb();
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "admin", level: 3, enabled: 1 });
    await next();
  });
  app.route("/rest", routes);
  return {
    db,
    hit(path: string) {
      return app.fetch(new Request(`http://test${path}`), { DB: db, INSTANCE_ID: "test" });
    },
  };
}

function lastBind(calls: Call[], marker: string): unknown[] {
  return calls.filter((call) => call.sql.includes(marker)).at(-1)?.binds ?? [];
}

async function run() {
  console.log("search routes clamp counts and offsets before D1:");
  {
    const { db, hit } = makeApp(searchRoutes);
    await hit("/rest/search3?query=x&artistCount=99999&artistOffset=99999999&albumCount=-1&songCount=99999&songOffset=-5");
    const artist = lastBind(db.calls, "FROM artists");
    const album = lastBind(db.calls, "FROM albums");
    const song = lastBind(db.calls, "FROM song_masters");
    assert(artist.at(-2) === MAX_PAGE_SIZE && artist.at(-1) === MAX_PAGE_OFFSET, "search3 artist limit and offset are bounded");
    assert(album.at(-2) === 20, "search3 invalid albumCount uses protocol default");
    assert(song.at(-2) === MAX_PAGE_SIZE && song.at(-1) === 0, "search3 song limit is bounded and negative offset resets");
    await hit("/rest/search3?query=x&artistCount=0&albumCount=0&songCount=0");
    assert(lastBind(db.calls, "FROM artists").at(-2) === 0, "search can omit artists with zero count");
    assert(lastBind(db.calls, "FROM albums").at(-2) === 0, "search can omit albums with zero count");
    assert(lastBind(db.calls, "FROM song_masters").at(-2) === 0, "search can omit songs with zero count");
  }

  console.log("browse routes clamp list and genre pages before D1:");
  {
    const { db, hit } = makeApp(browsingRoutes);
    await hit("/rest/getAlbumList2?type=newest&size=99999&offset=99999999");
    const albums = lastBind(db.calls, "FROM albums a");
    assert(albums.at(-2) === MAX_PAGE_SIZE && albums.at(-1) === MAX_PAGE_OFFSET, "album list limit and offset are bounded");
    db.calls.length = 0;
    await hit("/rest/getSongsByGenre?genre=Rock&count=99999&offset=-2");
    const songs = lastBind(db.calls, "WHERE sm.genre");
    assert(songs.at(-2) === MAX_PAGE_SIZE && songs.at(-1) === 0, "genre list limit is bounded and negative offset resets");
  }

  console.log("podcast route clamps newest count before D1:");
  {
    const { db, hit } = makeApp(podcastsRoutes);
    await hit("/rest/getNewestPodcasts?count=99999");
    const episodes = lastBind(db.calls, "FROM podcast_episodes");
    assert(episodes.at(-1) === MAX_PAGE_SIZE, "newest podcasts limit is bounded");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

void run();
