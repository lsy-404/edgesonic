import * as fs from "node:fs";
import * as path from "node:path";

const source = fs.readFileSync(path.resolve(__dirname, "../../web/src/lib/netDiag.ts"), "utf8");
const checks: [string, boolean][] = [
  ["keeps the existing generic request handle", source.includes("export function beginRequest(label: string, url: string): InflightHandle")],
  ["tracks native audio separately from byte progress", source.includes("export function beginAudioRequest") && source.includes("bufferedSeconds")],
  ["does not use buffered seconds as byte progress", !/progress\(bufferedSeconds/.test(source)],
  ["redacts query credentials from URLs", source.includes("u.pathname") && source.includes("(invalid URL)")],
  ["records navigation timing", source.includes("observeNavigationTimings")],
  ["records API resource timing", source.includes('name.includes("/rest/")')],
  ["captures bounded pagehide state", source.includes("SNAPSHOT_LIMIT") && source.includes("savePagehideSnapshot")],
];

let failures = 0;
for (const [label, passed] of checks) {
  if (passed) console.log(`  PASS ${label}`);
  else { failures++; console.error(`  FAIL ${label}`); }
}
process.exit(failures ? 1 : 0);
