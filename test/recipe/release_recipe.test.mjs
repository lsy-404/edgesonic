import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const recipe = JSON.parse(fs.readFileSync(path.join(root, "recipe/recipe.json"), "utf8"));
const recipeSource = fs.readFileSync(path.join(root, "recipe/recipe.js"), "utf8");
const buildSource = fs.readFileSync(path.join(root, "scripts/build-update-bundle.mjs"), "utf8");
const inputs = recipe.inputs;

assert.equal(recipe.issues.url, "https://github.com/wuyilingwei/edgesonic/issues/new");
assert.equal(inputs[0].id, "reset_admin");
assert.equal(inputs[0].onlyMode, "overwrite");
assert.equal(inputs[1].default, "admin");
assert.deepEqual(inputs[1].visibleWhen, { input: "reset_admin", equals: true, mode: "overwrite" });
assert.deepEqual(inputs[2].visibleWhen, { input: "reset_admin", equals: true, mode: "overwrite" });
assert.equal("pattern" in inputs[1], false, "administrator usernames are not restricted to ASCII");
assert.match(inputs[1].help.en, /Chinese|non-Latin/i);
assert.match(inputs[2].help.en, /empty.*random.*shown once.*final page.*never saved/i);

assert.match(recipeSource, /if \(mode === "fresh" \|\| resetAdmin\)/);
assert.match(recipeSource, /Existing superadmin preserved/);
assert.match(recipeSource, /ctx\.result\(\{\s*credentials:/s);
assert.match(recipeSource, /preserveLiveVars: \["INSTANCE_ID"\]/);
assert.doesNotMatch(recipeSource, /extraVars:\s*\{\s*INSTANCE_ID:/, "live INSTANCE_ID must be preserved by the host");
assert.match(recipeSource, /instanceId\s*\?\s*\{ assets, preserveLiveVars: \["INSTANCE_ID"\] \}\s*:\s*\{ assets \}/s);
assert.deepEqual(
  recipe.worker.vars.find((entry) => entry.name === "INSTANCE_ID"),
  { name: "INSTANCE_ID", value: "${uuid}" },
  "fresh installs must generate INSTANCE_ID from the recipe",
);
assert.match(buildSource, /const recipe = JSON\.parse/);
assert.match(buildSource, /JSON\.stringify\(recipe/);
assert.doesNotMatch(buildSource, /recipe\s*=\s*\{\s*version:/, "release build must retain recipe metadata fields");

console.log("release recipe administrator/support checks passed");
