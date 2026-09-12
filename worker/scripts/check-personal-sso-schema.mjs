import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workerDirectory = fileURLToPath(new URL("..", import.meta.url));
const query = "SELECT COUNT(*) AS identity_table FROM sqlite_master WHERE type = 'table' AND name = 'identity_accounts'";
const result = spawnSync("npx", [
  "wrangler",
  "d1",
  "execute",
  "edgesonic-db",
  "--remote",
  "--json",
  "--command",
  query,
], { cwd: workerDirectory, encoding: "utf8", env: process.env });

if (result.status !== 0) {
  process.stderr.write(result.stderr || "Unable to inspect the EdgeSonic database.\n");
  process.exit(result.status || 1);
}

let response;
try {
  response = JSON.parse(result.stdout);
} catch {
  process.stderr.write("Unable to parse the D1 schema preflight response.\n");
  process.exit(1);
}

const installed = Array.isArray(response)
  && response.some((entry) => Array.isArray(entry?.results) && entry.results.some((row) => Number(row?.identity_table) === 1));
if (!installed) {
  process.stderr.write("Personal SSO identity schema is not installed. Apply the personal-sso D1 migration before deploying EdgeSonic.\n");
  process.exit(1);
}

process.stdout.write("Personal SSO identity schema is ready.\n");
