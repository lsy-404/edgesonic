import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

const credentials = read("installer/src/components/steps/StepCredentials.vue");
const target = read("installer/src/components/steps/StepTarget.vue");
const version = read("installer/src/components/steps/StepVersion.vue");
const review = read("installer/src/components/steps/StepReview.vue");
const orchestrate = read("installer/src/lib/deploy/orchestrate.ts");
const deployTypes = read("installer/src/lib/deploy/types.ts");
const tokenPolicies = read("installer/src/lib/cf/tokenPolicies.ts");
const allowlist = read("installer/worker/cfAllowlist.ts");
const manifest = read("installer/src/lib/deploy/manifest.ts");
const en = JSON.parse(read("installer/src/locales/en.json"));
const zh = JSON.parse(read("installer/src/locales/zh-CN.json"));

const checks: Array<[string, boolean]> = [
  ["minimum permissions cover deploy resources", ["d1", "r2", "ci", "scripts"].every((key) => credentials.includes(`"${key}"`))],
  ["container and observability permissions are optional", credentials.includes('{ key: "containers", required: false')
    && credentials.includes('{ key: "observability", required: false')],
  ["stored token purpose is disclosed", en.credentials.advancedPermissionsDesc.includes("CF_API_TOKEN")
    && zh.credentials.advancedPermissionsDesc.includes("CF_API_TOKEN")],
  ["DNS is not a minimum verification gate", !credentials.includes('key: "dns"')],
  ["R2 direct-play keys are optional", credentials.includes("r2KeysComplete")
    && orchestrate.includes("if (creds.r2AccessKeyId && creds.r2SecretAccessKey)")],
  ["permissions are checked before resource creation", deployTypes.includes('"preflight"')
    && orchestrate.indexOf('guarded("preflight"') < orchestrate.indexOf('guarded("d1"')],
  ["overwrite searches worker, D1, and R2 names", target.includes("listScriptNames")
    && target.includes("listDatabaseNames") && target.includes("listBucketNames")],
  ["overwrite discovery uses EdgeSonic keywords", target.includes("looksLikeEdgeSonic")],
  ["overwrite requires an existing confirmed worker", target.includes("collision.value === true && wizard.overwriteConfirmed")],
  ["overwrite guidance prefers in-app updates", [credentials, target, version, review].every((source) => source.includes("overwriteAdvice.message"))],
  ["token policies cover every deployment and post-deploy permission", ["apiTokens", "scripts", "d1", "r2", "ci", "containers", "observability", "accountAnalytics", "accountSettings", "zoneRead", "zoneSettings"].every((key) => tokenPolicies.includes(key) && credentials.includes(`key: "${key}"`))],
  ["token policy read route is relay allowlisted", allowlist.includes('["accounts", null, "tokens", null]')],
  ["Account API Tokens Read policy name is recognized", tokenPolicies.includes('"Account API Tokens Read"')],
  ["write policy names use Cloudflare's current access level", ["Workers Scripts Write", "D1 Write", "Workers R2 Storage Write"].every((name) => tokenPolicies.includes(`"${name}"`))],
  ["core deployment permissions fall back to non-mutating API checks", ["/workers/scripts", "/d1/database"].every((path) => credentials.includes(path))],
  ["saved credentials are checked on page entry", credentials.includes("{ immediate: true }")],
  ["local ZIP packages are checksum-validated before deployment", manifest.includes("readLocalUpdatePackage") && manifest.includes("validateManifestAndArtifact") && version.includes("localPackage")],
];

let failures = 0;
for (const [label, passed] of checks) {
  if (passed) console.log(`  PASS ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}`);
  }
}

if (failures > 0) process.exit(1);
