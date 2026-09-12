import { spaHashRedirect } from "../../worker/src/spa";

let failures = 0;
function assert(condition: boolean, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

function redirect(path: string, init?: RequestInit): Response | null {
  return spaHashRedirect(new Request(`https://music.example${path}`, init));
}

const login = redirect("/login?next=%2Flibrary");
assert(login?.status === 308, "redirects a Vue login path permanently");
assert(login?.headers.get("Location") === "https://music.example/#/login?next=%2Flibrary",
  "preserves the frontend path and query inside the hash");

assert(redirect("/library")?.headers.get("Location") === "https://music.example/#/library",
  "redirects another deep frontend route to its hash route");
for (const path of ["/rest/ping", "/tag/list", "/storage/files", "/edgesonic/version", "/share/abc"]) {
  assert(redirect(path) === null, `keeps server path ${path} out of SPA fallback`);
}
for (const path of ["/assets/app.js", "/favicon.svg", "/build-info.json", "/unknown.css"]) {
  assert(redirect(path) === null, `keeps static resource ${path} out of SPA fallback`);
}
assert(redirect("/login", { method: "POST" }) === null, "does not redirect non-GET requests");

if (failures > 0) process.exit(1);
