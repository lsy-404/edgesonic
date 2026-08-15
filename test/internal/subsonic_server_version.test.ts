import { replaceSubsonicServerVersion, subsonicOK, subsonicServerVersion } from "../../worker/src/utils/xml";
import { formatMiddleware } from "../../worker/src/middleware/format";
import { Hono } from "hono";

let failures = 0;
function assert(condition: boolean, message: string) {
  if (condition) console.log(`  OK ${message}`);
  else {
    failures++;
    console.error(`  FAIL ${message}`);
  }
}

console.log("Subsonic server version:");
assert(subsonicServerVersion("1.2.6") === "1.2.6", "release version is retained");
assert(subsonicServerVersion("v1.2.6-dev.abc123-dirty") === "1.2.6", "development markers are hidden");
assert(subsonicServerVersion("invalid") === "1.3.0", "invalid version uses the release fallback");

const response = replaceSubsonicServerVersion(subsonicOK({}), "1.2.6-dev.abc123");
assert(response.includes('serverVersion="1.2.6"'), "Subsonic XML envelope uses the deployed release version");
assert(!response.includes('serverVersion="1.0.0"'), "Subsonic XML envelope no longer reports 1.0.0");

async function testResponseFormats() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/*", formatMiddleware);
  app.get("/ping", (c) => c.text(subsonicOK({}), 200, { "Content-Type": "application/xml; charset=UTF-8" }));
  app.get("/raw", (c) => c.text("<note>unchanged</note>", 200, { "Content-Type": "application/xml; charset=UTF-8" }));
  const env = { EDGESONIC_VERSION: "v1.2.6-dev.abc123-dirty" } as Env;

  const xml = await app.fetch(new Request("https://example.test/ping"), env);
  assert((await xml.text()).includes('serverVersion="1.2.6"'), "XML response uses sanitized deployed version");

  const json = await app.fetch(new Request("https://example.test/ping?f=json"), env);
  const body = await json.json() as { "subsonic-response"?: { serverVersion?: string } };
  assert(body["subsonic-response"]?.serverVersion === "1.2.6", "JSON response uses sanitized deployed version");

  const raw = await app.fetch(new Request("https://example.test/raw"), env);
  assert(await raw.text() === "<note>unchanged</note>", "non-Subsonic XML response body is preserved");
}

void testResponseFormats().then(() => {
  if (failures > 0) process.exitCode = 1;
});
