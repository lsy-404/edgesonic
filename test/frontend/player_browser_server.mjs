import { build } from "esbuild";
import http from "node:http";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bundle = await build({
  stdin: { resolveDir: root, loader: "ts", contents: `
    import { createPinia } from 'pinia';
    import { usePlayerStore } from './web/src/stores/player';
    import { initNetDiag } from './web/src/lib/netDiag';
    const player = usePlayerStore(createPinia());
    initNetDiag();
    for (const mode of ['normal', 'recover', 'hold']) {
      document.getElementById(mode).onclick = () => player.setQueue([{
        id: mode, title: mode, artist: 'Test', album: 'Test', duration: 30,
        streamUrl: new URL('/audio?case=' + mode, location.href).href,
      }]);
    }
    document.getElementById('toggle').onclick = () => player.toggle();
    document.getElementById('clear').onclick = () => player.clear();
    setInterval(() => {
      document.getElementById('state').textContent = JSON.stringify({
        track: player.current?.id, playing: player.playing,
        time: Number(player.currentTime.toFixed(1)), duration: player.duration,
        inflight: window.__esNetDiag.inflight().map(r => ({label:r.label,bytes:r.bytes,audio:r.audio})),
      });
    }, 100);
  ` },
  bundle: true, write: false, format: "esm", platform: "browser",
  define: { __VUE_OPTIONS_API__: "true", __VUE_PROD_DEVTOOLS__: "false", __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false" },
});

const audio = Buffer.alloc(44 + 30 * 8_000 * 2);
audio.write("RIFF", 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8);
audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(8_000, 24); audio.writeUInt32LE(16_000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
audio.write("data", 36); audio.writeUInt32LE(audio.length - 44, 40);
const attempts = new Map();
const requests = [];
const page = '<!doctype html><meta charset="utf-8"><title>Player recovery check</title><h1>Player recovery check</h1><button id="normal">Play normal audio</button><button id="recover">Recover failed audio</button><button id="hold">Start stalled recovery</button><button id="toggle">Pause or resume</button><button id="clear">Clear player</button><pre id="state"></pre><script type="module" src="/fixture.js"></script>';
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/fixture.js") {
    response.writeHead(200, { "Content-Type": "application/javascript" }); response.end(bundle.outputFiles[0].contents); return;
  }
  if (url.pathname === "/stats") {
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(requests)); return;
  }
  if (url.pathname === "/audio") {
    const mode = url.searchParams.get("case");
    const range = request.headers.range || "";
    const manual = /^bytes=\d+-\d+$/.test(range);
    const entry = { mode, range, manual, closed: false };
    requests.push(entry);
    response.on("close", () => { entry.closed = true; });
    if (mode !== "normal" && !manual) {
      response.writeHead(503, { "Content-Type": "text/plain" }); response.end("retry as a bounded range"); return;
    }
    const count = (attempts.get(mode) || 0) + 1;
    attempts.set(mode, count);
    const start = Number(range.match(/^bytes=(\d+)/)?.[1] || 0);
    const body = audio.subarray(start);
    response.writeHead(206, { "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${audio.length-1}/${audio.length}`, "Content-Length": body.length });
    if (mode === "hold" && count === 1) response.write(body.subarray(0, 1024));
    else response.end(body);
    return;
  }
  if (url.pathname.startsWith("/rest/") || url.pathname.startsWith("/edgesonic/")) {
    response.writeHead(200, { "Content-Type": "application/xml" }); response.end('<subsonic-response status="ok"/>'); return;
  }
  response.writeHead(200, { "Content-Type": "text/html" }); response.end(page);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
console.log(`Player check: http://127.0.0.1:${server.address().port}/`);
process.on("SIGINT", () => { server.closeAllConnections(); server.close(); });
