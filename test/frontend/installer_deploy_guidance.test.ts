import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

const credentials = read("installer/src/components/steps/StepCredentials.vue");
const target = read("installer/src/components/steps/StepTarget.vue");
const done = read("installer/src/components/steps/StepDone.vue");
const welcome = read("installer/src/components/steps/StepWelcome.vue");
const orchestrate = read("installer/src/lib/deploy/orchestrate.ts");
const deployTypes = read("installer/src/lib/deploy/types.ts");
const tokenPolicies = read("installer/src/lib/cf/tokenPolicies.ts");
const allowlist = read("installer/worker/cfAllowlist.ts");
const manifest = read("installer/src/lib/deploy/manifest.ts");
const assets = read("installer/src/lib/deploy/assets.ts");
const rebuild = read("installer/src/lib/deploy/rebuild.ts");
const workerVersion = read("installer/src/lib/deploy/workerVersion.ts");
const installerStyle = read("installer/src/style.css");
const en = JSON.parse(read("installer/src/locales/en.json"));
const zh = JSON.parse(read("installer/src/locales/zh-CN.json"));

const checks: Array<[string, boolean]> = [
  ["minimum permissions cover deploy resources", ["d1", "r2", "ci", "scripts"].every((key) => credentials.includes(`"${key}"`))],
  ["container and observability permissions are optional", /key: "containers"[\s\S]*?requirement: "optional"/.test(credentials)
    && /key: "observability"[\s\S]*?requirement: "optional"/.test(credentials)],
  ["deployment gates on the three resources it writes to", credentials.includes('new Set(["token", "scripts", "d1", "r2"])')
    && /key: "apiTokens"[\s\S]*?requirement: "recommended"/.test(credentials)
    && orchestrate.includes('for (const key of ["scripts", "d1", "r2"] as const)')
    && [en, zh].every((locale) => ["required", "recommended", "optional"].every((key) => locale.credentials.requirements[key]))],
  ["an unreadable policy list downgrades the token to a readable checklist, not a failure",
    orchestrate.includes("groups = await readTokenPermissionGroups") && orchestrate.includes("if (groups) {")
    && credentials.includes('setCheck(key, "unknown"') && [en, zh].every((locale) => locale.credentials.checkStatus.unknown)],
  ["the permission checklist can be re-run by hand", credentials.includes("function recheck")
    && credentials.includes("permission-head") && installerStyle.includes(".permission-head")
    && [en, zh].every((locale) => locale.credentials.recheck)],
  ["stored token purpose is disclosed", en.credentials.apiTokenStorageNote.includes("CF_API_TOKEN")
    && zh.credentials.apiTokenStorageNote.includes("CF_API_TOKEN")
    && credentials.includes("credentials.apiTokenStorageNote")],
  ["DNS is not a minimum verification gate", !credentials.includes('key: "dns"')],
  ["R2 direct-play keys are optional", credentials.includes("r2KeysComplete")
    && orchestrate.includes("if (creds.r2AccessKeyId && creds.r2SecretAccessKey)")],
  ["permissions are checked before resource creation", deployTypes.includes('"preflight"')
    && orchestrate.indexOf('guarded("preflight"') < orchestrate.indexOf('guarded("d1"')],
  ["target detection chooses creation or recovery", target.includes('wizard.mode = exists ? "overwrite" : "fresh"')],
  ["existing Workers require confirmation before recovery", target.includes("collision.value === true && wizard.overwriteConfirmed")],
  ["public quick deploy starts from terms acceptance", welcome.includes("acceptTerms") && welcome.includes("DEPLOY_BY_AGENT.md") && !welcome.includes("freshTitle")],
  ["recovery can preserve or reset the superadmin", target.includes("wizard.resetAdmin") && orchestrate.includes("target.mode === \"fresh\" || target.resetAdmin")],
  ["initial superadmin password is optional", target.includes("wizard.adminPassword") && orchestrate.includes("target.adminPassword")],
  ["superadmin fields are offered only where the deploy applies them",
    target.includes('const adminSetupApplies = computed(() => wizard.mode === "fresh" || wizard.resetAdmin)')
    && target.includes('v-if="adminSetupApplies"')
    && [en, zh].every((locale) => !/reset|重置/.test(locale.target.adminPasswordHelp))],
  ["token policies cover every deployment and post-deploy permission", ["apiTokens", "scripts", "d1", "r2", "ci", "containers", "observability", "accountAnalytics", "accountSettings"].every((key) => tokenPolicies.includes(key) && credentials.includes(`key: "${key}"`))],
  ["the confusing Zone permission guide rows were dropped, not just renamed", !tokenPolicies.includes("zoneRead") && !credentials.includes('key: "zoneRead"') && !credentials.includes('key: "zoneSettings"')],
  ["token policy read route is relay allowlisted", allowlist.includes('["accounts", null, "tokens", null]')],
  ["Account API Tokens Read policy name is recognized", tokenPolicies.includes('"Account API Tokens Read"')],
  ["write policy names use Cloudflare's current access level", ["Workers Scripts Write", "D1 Write", "Workers R2 Storage Write"].every((name) => tokenPolicies.includes(`"${name}"`))],
  ["core deployment permissions fall back to non-mutating API checks", ["/workers/scripts", "/d1/database"].every((path) => credentials.includes(path))],
  ["saved credentials are checked on page entry", credentials.includes("{ immediate: true }")],
  ["release artifacts are checksum-validated before deployment", manifest.includes("sha256Hex") && manifest.includes("Update artifact checksum mismatch")],
  ["completion link opens the deployed Worker production page", done.includes("/workers/services/view/") && done.includes("/production")],
  ["asset uploads preserve JavaScript MIME types", assets.includes('return "text/javascript"') && assets.includes("new File([base64Bytes(bytes)]")],
  ["permission table includes categories and wraps content", credentials.includes("permissionCategory") && credentials.includes("permission.category") && installerStyle.includes("overflow-wrap: anywhere")],
  ["terms of service are a structured, formal document covering data handling, CF tracking/anti-abuse, and no availability guarantee",
    welcome.includes("section1Title") && welcome.includes("section2Title") && welcome.includes("section3Title") && welcome.includes("section4Title")
    && Object.keys(en.welcome).some((key) => key.startsWith("section")) && Object.keys(zh.welcome).some((key) => key.startsWith("section"))
    && /CF-Ray|Bot 检测|bot detection/.test(en.welcome.section2Item2 + zh.welcome.section2Item2)
    && /availability|可用性/.test(en.welcome.section4Body + zh.welcome.section4Body)],
  ["initial superadmin username is configurable end to end", target.includes("wizard.adminUsername")
    && target.includes("ADMIN_USERNAME_RE")
    && deployTypes.includes("adminUsername")
    && orchestrate.includes("target.adminUsername")
    && read("installer/src/lib/deploy/admin.ts").includes("requestedUsername")],
  ["D1 and R2 existence is stated in every deploy mode", target.includes("dbState") && target.includes("bucketState")
    && en.target.dbCollisionWarning && en.target.bucketCollisionWarning
    && [en, zh].every((locale) => ["dbExists", "dbAbsent", "dbUnknown", "bucketExists", "bucketAbsent", "bucketUnknown"].every((key) => locale.target[key]))],
  ["the account is scanned behind a cover so the target form does not rewrite itself",
    target.includes("scanning") && target.includes("WinProgressRing") && [en, zh].every((locale) => locale.target.scanning)],
  ["an account's own EdgeSonic D1/R2 are adopted over the generic defaults",
    target.includes("adoptExisting") && target.includes('ADOPT_KEYWORD = "edgesonic"')
    && [en, zh].every((locale) => locale.target.dbAdopted && locale.target.bucketAdopted)],
  ["a full rebuild is offered only after the overwrite is confirmed",
    target.includes("collision === true && wizard.overwriteConfirmed") && target.includes("wizard.fullRebuild")
    && [en, zh].every((locale) => locale.target.fullRebuild && locale.target.fullRebuildHelp && locale.execute.steps.rebuild)],
  ["a full rebuild deletes the script and redeploys it with a complete binding set",
    rebuild.includes("workers/scripts/${encodeURIComponent(script)}?force=true")
    && orchestrate.includes('target.mode === "overwrite" && target.fullRebuild')
    && orchestrate.includes('mode: rebuilding ? "fresh" : target.mode')],
  ["a full rebuild rescues what the redeploy cannot regenerate",
    orchestrate.includes("facts.instanceId || crypto.randomUUID()") && orchestrate.includes("restoreCustomDomains")
    && orchestrate.indexOf("readScriptFacts(apiToken") < orchestrate.indexOf("deleteScript(apiToken")],
  ["the transcoding container is a three-way choice defaulting to the live script's own state",
    rebuild.includes('entry.type === "durable_object_namespace" && entry.class_name === "Sandbox"')
    && orchestrate.includes('target.containerMode === "deploy" || (target.containerMode === "keep" && facts.hasSandboxContainer && !rebuilding)')
    && workerVersion.includes("if (input.declareContainer) metadata.containers")
    && target.includes('wizard.containerMode') && target.includes('value="deploy"') && target.includes('value="off"')
    && [en, zh].every((locale) => ["containerKeep", "containerDeploy", "containerOff"].every((key) => locale.target[key])
      && !locale.target.containerDeployWarning && locale.review.containerLabel)],
  ["script deletion and settings reads are relay allowlisted",
    allowlist.includes('{ method: "DELETE", segments: ["accounts", null, "workers", "scripts", null] }')
    && allowlist.includes('["accounts", null, "workers", "scripts", null, "settings"]')],
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
