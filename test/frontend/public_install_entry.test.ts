import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const overtureUrl = "https://overture.demo-w10v.workers.dev/?src=wuyilingwei%2Fedgesonic";
const oldInstallerUrl = ["https://edgesonic", "-installer.demo-w10v.workers.dev"].join("");
const publicEntrypoints = [
  "README.md",
  "README.zh-CN.md",
  "docs/DEPLOY_BY_AGENT.md",
  "docs/WORKER_SELF_UPDATE.md",
  "web/src/App.vue",
];

for (const file of publicEntrypoints) {
  const source = read(file);
  assert.ok(source.includes(overtureUrl), `${file} must expose the preselected Overture URL`);
  assert.equal(source.includes(oldInstallerUrl), false, `${file} must not expose the retired installer URL`);
}

console.log("public install entry checks passed");
