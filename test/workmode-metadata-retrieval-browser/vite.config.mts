import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const repository = resolve(root, "../..");
const events: Array<{ type: string; body: Record<string, unknown> }> = [];
let submission: Record<string, unknown> | undefined;

const song = {
  id: 724001,
  name: "Fixture Song",
  artists: [{ name: "Fixture Artist" }],
  album: { name: "Fixture Album", artists: [{ name: "Fixture Artist" }], publishTime: 1_704_067_200_000 },
};

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

const fixturePlugin: Plugin = {
  name: "workmode-metadata-retrieval-loopback-fixture",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const path = (req.url || "").split("?", 1)[0];
      try {
        if (req.method === "GET" && path === "/fixture/report") {
          const intents = events.filter((event) => event.type === "proxy").map((event) => event.body.intent);
          const result = submission?.result as Record<string, unknown> | undefined;
          const match = result?.match as Record<string, unknown> | undefined;
          const protocol = {
            search: intents.includes("search"),
            detail: intents.includes("detail"),
            lyric: intents.includes("lyric"),
            submit: !!submission,
            complete: intents.includes("search") && intents.includes("detail") && intents.includes("lyric") && !!submission,
          };
          return json(res, {
            provider: "local fixture only",
            protocol,
            events,
            submission: submission ? {
              accepted: true,
              id: submission.id,
              attempts: submission.attempts,
              result: {
                kind: result?.kind,
                status: result?.status,
                match: match ? {
                  source: match.source,
                  songId: match.songId,
                  title: match.title,
                  artist: match.artist,
                  album: match.album,
                  year: match.year,
                  lyrics: match.lyrics,
                } : undefined,
              },
            } : undefined,
            catalogReadback: "not performed; submit receipt is mocked",
          });
        }
        if (req.method === "POST" && path === "/fixture/reset") {
          events.length = 0;
          submission = undefined;
          return json(res, { ok: true });
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
        if (req.method === "POST" && path === "/fixture/work/heartbeat") {
          events.push({ type: "heartbeat", body: await readJson(req) });
          return json(res, { ok: true });
        }
        if (req.method === "POST" && path === "/fixture/work/submit") {
          submission = await readJson(req);
          events.push({ type: "submit", body: submission });
          return json(res, { ok: true });
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
  server: { host: "127.0.0.1", port: 4181, strictPort: true, fs: { allow: [repository] } },
});
