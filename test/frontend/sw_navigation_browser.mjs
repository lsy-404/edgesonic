import http from "node:http";
import { readFile } from "node:fs/promises";

const sw = await readFile(new URL("../../web/public/sw.js", import.meta.url), "utf8");
const requests = [];
const shell = `<!doctype html><meta charset="utf-8"><title>Navigation recovery check</title>
<style>body{font:20px system-ui;padding:32px;line-height:1.7}a{display:block;margin:16px 0}</style>
<h1>Navigation recovery check</h1><p id="state">Registering original service worker</p>
<a href="/?case=headers">Navigation with stalled response headers</a>
<a href="/?case=body">Navigation with stalled response body</a>
<script>
async function ready() {
  await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, {once:true}));
  document.querySelector('#state').textContent='Ready: real Service Worker controls this page';
}
ready().catch(e=>document.querySelector('#state').textContent=String(e));
</script>`;
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/stats") {
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(requests.map((r) => ({kind:r.kind,closed:r.closed,ageMs:Date.now()-r.started}))));
    return;
  }
  if (url.pathname === "/" && url.searchParams.has("case")) {
    const entry = { kind: url.searchParams.get("case"), started: Date.now(), closed: false };
    requests.push(entry);
    response.on("close", () => { entry.closed = true; });
    if (entry.kind === "body") {
      response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      response.write('<!doctype html><meta charset="utf-8"><title>Body still pending</title><h1>Partial response should never reach the page</h1><p>This partial document must be replaced by the cached shell.</p>');
    }
    return;
  }
  response.writeHead(200, { "Content-Type": url.pathname === "/sw.js" ? "application/javascript" : "text/html", "Cache-Control": "no-store" });
  response.end(url.pathname === "/sw.js" ? sw : shell);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
console.log(`Probe: http://127.0.0.1:${server.address().port}/`);
console.log("Close with Ctrl-C when browser observations are complete.");
process.on("SIGINT", () => { server.closeAllConnections(); server.close(); });
