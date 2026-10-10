import assert from "node:assert/strict";
import test from "node:test";
import { runMetadataRetrieval } from "../../web/src/lib/workmodeMetadataRetrieval";
import { fileNameFrom, prepareWorkerTask, type QueuedTask, type RunnerDeps } from "../../web/src/lib/taskRunner";
import type { ScrapeResult, ScrapeSource } from "../../web/src/lib/scrape";

const BASE = {
  kind: "metadata-retrieval",
  masterId: "master-1",
  instanceId: "instance-1",
  sourceUri: "r2://library/song.mp3",
  sourceEtag: "etag-1",
  identity: { title: "Blue Sky", artist: "Singer", album: "First Album" },
  snapshot: { title: "Blue Sky", artist: "Singer", album: "First Album", coverR2Key: "cover-key" },
  sources: ["netease", "qmusic", "kugou", "lrc"],
  query: "Blue Sky Singer First Album",
} as const;

function result(overrides: Partial<ScrapeResult> = {}): ScrapeResult {
  return { source: "netease", songId: "42", title: "Blue Sky", artist: "Singer", album: "First Album", ...overrides };
}

function adapters(
  results: ScrapeResult[],
  errors: Array<{ source: ScrapeSource; error: string }> = [],
) {
  return {
    searchAll: async () => ({ results, errors }),
    resolveResult: async (candidate: ScrapeResult) => candidate,
  } as const;
}

const noFetch = (async () => { throw new Error("unexpected fetch"); }) as typeof fetch;

test("retrieval accepts exact anchors and collapses the same identity across providers", async () => {
  const output = await runMetadataRetrieval(BASE, "https://app.example/tag/scrape", new AbortController().signal, noFetch,
    adapters([result(), result({ source: "qmusic", songId: "qq-42" })]));
  assert.equal(output.status, "matched");
  assert.equal(output.match?.title, "Blue Sky");
  assert.equal(output.match?.source, "netease");
});

test("retrieval refuses live or instrumental variants and candidates with no known anchor", async () => {
  const live = await runMetadataRetrieval(BASE, "https://app.example/tag/scrape", new AbortController().signal, noFetch,
    adapters([result({ title: "Blue Sky Live" })]));
  assert.deepEqual([live.status, live.reason], ["no-match", "no-credible-match"]);

  const unknowns = {
    ...BASE,
    identity: { title: "Blue Sky", artist: "Unknown Artist", album: "Pending Uploads" },
    snapshot: { title: "Blue Sky", artist: "Unknown Artist", album: "Pending Uploads", coverR2Key: "cover-key" },
  };
  const missingAnchor = await runMetadataRetrieval(unknowns, "https://app.example/tag/scrape", new AbortController().signal, noFetch,
    adapters([result({ album: "A Different Album" })]));
  assert.deepEqual([missingAnchor.status, missingAnchor.reason], ["no-match", "no-credible-match"]);
});

test("known raw snapshot fields constrain derived identity hints", async () => {
  const hinted = {
    ...BASE,
    identity: { title: "Blue Sky", artist: "Other Singer", album: "First Album" },
  };
  const conflicting = await runMetadataRetrieval(hinted, "https://app.example/tag/scrape", new AbortController().signal, noFetch,
    adapters([result({ artist: "Other Singer" })]));
  assert.deepEqual([conflicting.status, conflicting.reason], ["no-match", "no-credible-match"]);
});

test("distinct credible album identities complete as ambiguous no-match", async () => {
  const ambiguous = {
    ...BASE,
    identity: { title: "Blue Sky", artist: "Singer" },
    snapshot: { title: "Blue Sky", artist: "Singer", album: "Unknown Album", coverR2Key: "cover-key" },
  };
  const output = await runMetadataRetrieval(ambiguous, "https://app.example/tag/scrape", new AbortController().signal, noFetch,
    adapters([result(), result({ source: "qmusic", songId: "other", album: "Second Album" })]));
  assert.deepEqual([output.status, output.reason], ["no-match", "ambiguous"]);
});

test("a matching search result remains usable when optional provider detail lookup fails", async () => {
  const output = await runMetadataRetrieval(BASE, "https://app.example/tag/scrape", new AbortController().signal, noFetch, {
    searchAll: async () => ({ results: [result()], errors: [] }),
    resolveResult: async () => { throw new Error("provider detail unavailable"); },
  });
  assert.equal(output.status, "matched");
  assert.equal(output.match?.songId, "42");
});

test("all provider failures throw for queue retry", async () => {
  await assert.rejects(
    runMetadataRetrieval(BASE, "https://app.example/tag/scrape", new AbortController().signal, noFetch,
      adapters([], BASE.sources.map((source) => ({ source, error: "offline" }))),
    ),
    /all metadata sources failed/,
  );
});

test("an aborted retrieval exits before contacting providers", async () => {
  const controller = new AbortController();
  controller.abort();
  let searched = false;
  await assert.rejects(
    runMetadataRetrieval(BASE, "https://app.example/tag/scrape", controller.signal, noFetch, {
      searchAll: async () => { searched = true; return { results: [], errors: [] }; },
      resolveResult: async (candidate) => candidate,
    }),
    { name: "AbortError" },
  );
  assert.equal(searched, false);
});

test("scrape proxy requests use the same-origin management endpoint and keep cookies", async () => {
  let seen: { url: string; method?: string; credentials?: RequestCredentials; body?: string } | undefined;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = {
      url: String(input), method: init?.method, credentials: init?.credentials,
      body: String(init?.body || ""),
    };
    return Response.json({ ok: true, data: { result: { songs: [] } } });
  }) as typeof fetch;
  const output = await runMetadataRetrieval(BASE, "https://app.example/tag/scrape", new AbortController().signal, fetcher, {
    searchAll: async (opts) => {
      await opts.proxyFetch({ source: "netease", intent: "search", query: opts.query });
      return { results: [result()], errors: [] };
    },
    resolveResult: async (candidate) => candidate,
  });
  assert.equal(output.status, "matched");
  assert.equal(seen?.url, "https://app.example/tag/scrape");
  assert.equal(seen?.method, "POST");
  assert.equal(seen?.credentials, "same-origin");
  assert.deepEqual(JSON.parse(seen?.body || "{}"), { source: "netease", intent: "search", query: BASE.query });
});

test("cover download is skipped when it exceeds the server's bounded image size", async () => {
  let coverRequested = false;
  const fetcher = (async () => {
    coverRequested = true;
    return new Response(new Uint8Array(200_001), {
      headers: { "Content-Type": "image/jpeg", "Content-Length": "200001" },
    });
  }) as typeof fetch;
  const output = await runMetadataRetrieval({
    ...BASE,
    snapshot: { title: "Blue Sky", artist: "Singer", album: "First Album", coverR2Key: null },
  }, "https://app.example/tag/scrape", new AbortController().signal, fetcher,
  adapters([result({ coverUrl: "https://lrc.voidcarve.com/albums/cover.jpg" })]));
  assert.equal(output.status, "matched");
  assert.equal(coverRequested, true);
  assert.equal(output.cover, undefined);
});

test("missing covers are returned only when the MIME and image signature agree", async () => {
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWioAAAAASUVORK5CYII="),
    (character) => character.charCodeAt(0));
  const fetcher = (async () => new Response(png, { headers: { "Content-Type": "image/png" } })) as typeof fetch;
  const output = await runMetadataRetrieval({
    ...BASE,
    snapshot: { title: "Blue Sky", artist: "Singer", album: "First Album", coverR2Key: null },
  }, "https://app.example/tag/scrape", new AbortController().signal, fetcher,
  adapters([result({ coverUrl: "https://lrc.voidcarve.com/albums/cover.png" })]));
  assert.equal(output.cover?.mime, "image/png");
  assert.equal(output.cover?.data, btoa(String.fromCharCode(...png)));
});

test("runner injects the same-origin management scrape route without changing claim identity", () => {
  const calls: string[] = [];
  const deps: RunnerDeps = {
    restUrl: (path) => { calls.push(path); return `https://app.example/rest/${path}`; },
    edgesonicPost: async () => "{}",
  };
  const task: QueuedTask = {
    id: "queue-item", taskType: "scrape", payload: { ...BASE }, requiredCaps: [], priority: 1,
    attempts: 2, maxAttempts: 5, claimedAt: 123, heartbeatAt: 124,
  };
  const prepared = prepareWorkerTask(task, deps, "https://app.example");
  assert.equal(prepared.payload.scrapeProxyUrl, "https://app.example/tag/scrape");
  assert.equal(prepared.attempts, 2);
  assert.equal(prepared.claimedAt, 123);
  assert.deepEqual(calls, []);
  assert.equal(task.payload.scrapeProxyUrl, undefined);
  assert.equal(fileNameFrom(task), "Blue Sky");
});
