import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const configPath = path.join(root, "worker/wrangler.toml.example");
const config = fs.readFileSync(configPath, "utf8");

function readValue(block, key) {
  const match = block.match(new RegExp(`^\\s*${key}\\s*=\\s*([^\\n#]+)`, "m"));
  assert.ok(match, `missing ${key}`);
  return match[1].trim().replace(/^"|"$/g, "");
}

test("the public Wrangler template declares independent auth and API limits", () => {
  const blocks = [...config.matchAll(/\[\[ratelimits\]\]([\s\S]*?)(?=\[\[ratelimits\]\]|$)/g)]
    .map(([, block]) => block);

  assert.equal(blocks.length, 2);
  const limits = blocks.map((block) => ({
    name: readValue(block, "name"),
    namespaceId: readValue(block, "namespace_id"),
    limit: Number(readValue(block, "limit")),
    period: Number(readValue(block, "period")),
  }));

  assert.deepEqual(limits, [
    { name: "AUTH_RATE_LIMITER", namespaceId: "140001", limit: 20, period: 60 },
    { name: "API_RATE_LIMITER", namespaceId: "140002", limit: 1200, period: 60 },
  ]);
  assert.ok(limits.every(({ namespaceId }) => /^[1-9][0-9]*$/.test(namespaceId)));
  assert.equal(new Set(limits.map(({ namespaceId }) => namespaceId)).size, limits.length);
});
