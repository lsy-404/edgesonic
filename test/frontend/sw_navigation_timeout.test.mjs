import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { gzipSync } from "node:zlib";
import vm from "node:vm";

const connections = [];
const server = http.createServer((request, response) => {
  let closed;
  const entry = { url: request.url, closed: new Promise((resolve) => { closed = resolve; }) };
  connections.push(entry);
  response.on("close", closed);
  if (request.url.includes("body")) {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.write("<!doctype html><title>Incomplete</title>");
  } else if (request.url.includes("complete")) {
    const body = gzipSync("<!doctype html><title>Complete shell</title>");
    response.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip", "Content-Length": body.byteLength });
    response.end(body);
  } else if (request.url.includes("error")) {
    response.writeHead(503, { "Content-Type": "text/html" });
    response.end("unavailable");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const listeners = new Map();
const logs = [];
const cacheWrites = [];
let cachedBody = "cached shell";
let cacheAvailable = true;
const context = vm.createContext({
  URL, Request, Response, Headers, AbortController, DOMException, performance, setTimeout, clearTimeout,
  fetch: globalThis.fetch,
  self: { location: { origin }, addEventListener: (name, callback) => listeners.set(name, callback) },
  console: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
  caches: {
    async open() {
      if (!cacheAvailable) throw new Error("Cache unavailable");
      return {
        async match() { return cachedBody === null ? undefined : new Response(cachedBody); },
        async put(_key, response) { cachedBody = await response.text(); },
      };
    },
  },
});
vm.runInContext(await readFile(new URL("../../web/public/sw.js", import.meta.url), "utf8"), context);

function dispatch(path, { signal, headers, navigate = true } = {}) {
  const request = new Request(`${origin}${path}`, { signal, headers });
  if (navigate) Object.defineProperty(request, "mode", { value: "navigate" });
  let result;
  listeners.get("fetch")({
    request,
    respondWith(value) { result = value; },
    waitUntil(value) { cacheWrites.push(value); },
  });
  return result;
}

async function withDeadline(promise, milliseconds = 6_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Test deadline exceeded")), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

try {
  const started = performance.now();
  const [headers, body] = await withDeadline(Promise.all([
    dispatch("/?headers&token=private-marker"),
    dispatch("/?body&token=private-marker"),
  ]));
  assert.equal(await headers.text(), "cached shell");
  assert.equal(await body.text(), "cached shell");
  await withDeadline(Promise.all(connections.map((entry) => entry.closed)), 1_000);
  assert.ok(performance.now() - started >= 3_900, "production navigation timeout is exercised");
  assert.ok(!JSON.stringify(logs).includes("private-marker"), "navigation logs omit query credentials");
  console.log("PASS stalled headers and body return cached shell within deadline and close both real HTTP requests");

  const count = connections.length;
  const canceled = new AbortController();
  canceled.abort();
  assert.equal((await withDeadline(dispatch("/?canceled", { signal: canceled.signal }))).type, "error");
  assert.equal(connections.length, count, "an already-aborted navigation never reaches the server");

  const ongoing = new AbortController();
  const navigation = dispatch("/?body-cancel", { signal: ongoing.signal });
  const timer = setTimeout(() => ongoing.abort(), 100);
  assert.equal((await withDeadline(navigation, 1_000)).type, "error");
  clearTimeout(timer);
  await withDeadline(connections.at(-1).closed, 1_000);
  console.log("PASS navigation cancellation aborts response-body transfer without serving a cached document");

  const fresh = await withDeadline(dispatch("/?complete"));
  assert.equal(await fresh.text(), "<!doctype html><title>Complete shell</title>");
  assert.equal(fresh.headers.get("Content-Encoding"), null);
  assert.equal(fresh.headers.get("Content-Length"), null);
  await Promise.all(cacheWrites);
  assert.equal(cachedBody, "<!doctype html><title>Complete shell</title>");
  const failed = await withDeadline(dispatch("/?error"));
  assert.equal(failed.status, 503);
  assert.equal(await failed.text(), "unavailable");
  assert.equal(cachedBody, "<!doctype html><title>Complete shell</title>");
  console.log("PASS complete decoded HTML is cached and failed HTTP responses cannot poison the shell");

  cacheAvailable = false;
  assert.equal((await withDeadline(dispatch("/?complete"))).status, 200, "cache errors do not block the live shell");
  assert.equal((await withDeadline(dispatch("/?body-no-cache"))).type, "error", "unavailable cache still yields a terminal response");
  await withDeadline(connections.at(-1).closed, 1_000);
  console.log("PASS cache failures do not block network success or timeout termination");

  assert.equal(dispatch("/share/example"), undefined);
  assert.equal(dispatch("/rest/stream", { navigate: false }), undefined);
  assert.equal(dispatch("/?headers", { headers: { Range: "bytes=0-" } }), undefined);
  console.log("PASS public shares, APIs and media ranges bypass the application shell");
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await Promise.all(cacheWrites);
}
