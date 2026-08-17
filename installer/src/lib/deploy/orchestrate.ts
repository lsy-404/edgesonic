// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

import type { GithubRelease } from "../../../../shared/autoupdate";
import { fetchSchemaSql } from "../github";
import { getOrCreateDatabase, runQuery } from "./d1";
import { getOrCreateBucket, listBucketNames } from "./r2";
import { callCfJson, verifyR2Keys } from "../relay";
import { fetchManifestAndArtifact } from "./manifest";
import type { LocalUpdatePackage } from "./manifest";
import { hasTokenPermission, readTokenPermissionGroups } from "../cf/tokenPolicies";
import { unpackArtifact, textFile } from "./tar";
import { uploadAssets, type AssetManifest } from "./assets";
import { uploadWorkerVersion, switchTraffic, readCrons } from "./workerVersion";
import { deleteScript, listCustomDomains, readInstanceId, restoreCustomDomains, type CustomDomain } from "./rebuild";
import { pushSecret } from "./secrets";
import { setCron, DEFAULT_CRON } from "./cron";
import { createSuperadmin } from "./admin";
import { generateHmacKeyBase64 } from "./crypto";
import { probeReachable } from "./health";
import { DeployError, type DeployCredentials, type DeployResult, type DeployStep, type DeployTarget, type StepStatus } from "./types";

export type StepReporter = (step: DeployStep, status: StepStatus, detail?: string) => void;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function guarded<T>(step: DeployStep, report: StepReporter, run: () => Promise<T>): Promise<T> {
  report(step, "running");
  try {
    const result = await run();
    report(step, "success");
    return result;
  } catch (error) {
    const message = error instanceof DeployError ? error.message : messageOf(error);
    report(step, "failed", message);
    throw error instanceof DeployError ? error : new DeployError(step, message);
  }
}

async function verifyDeploymentAccess(creds: DeployCredentials): Promise<string> {
  const { accountId, apiToken, r2AccessKeyId, r2SecretAccessKey } = creds;
  const verified = await callCfJson<{ id?: string }>(apiToken, `/accounts/${accountId}/tokens/verify`, undefined, "an active Account API Token");
  if (!verified.id) throw new Error("Cloudflare did not return the API Token identifier");
  const groups = await readTokenPermissionGroups(apiToken, accountId, verified.id);
  for (const key of ["apiTokens", "scripts", "d1", "r2"] as const) {
    if (!hasTokenPermission(groups, key)) throw new Error(`Missing required token permission: ${key}`);
  }
  await callCfJson(apiToken, `/accounts/${accountId}/workers/scripts`, undefined, "Workers Scripts Edit");
  await callCfJson(apiToken, `/accounts/${accountId}/d1/database`, undefined, "D1 Edit");
  await listBucketNames(apiToken, accountId);
  const permissionSummary = ["Account API Token", "Account API Tokens", "Workers Scripts", "D1", "Workers R2 Storage"];
  permissionSummary.push(
    await callCfJson(apiToken, `/accounts/${accountId}`, undefined, "Account Settings Read").then(
      () => "Account Settings: enabled",
      () => "Account Settings: not enabled",
    ),
  );
  if (r2AccessKeyId && r2SecretAccessKey) {
    const verified = await verifyR2Keys({ accountId, accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey });
    if (!verified.ok) throw new Error(verified.message || "R2 access key pair did not verify");
    permissionSummary.push("R2 S3 API key");
  } else {
    permissionSummary.push("R2 S3 API key not configured");
  }
  return `Verified: ${permissionSummary.join(", ")}`;
}

export async function runDeploy(creds: DeployCredentials, target: DeployTarget, release: GithubRelease | LocalUpdatePackage, report: StepReporter): Promise<DeployResult> {
  const { accountId, apiToken } = creds;
  const script = target.workerName;
  const tag = "kind" in release ? release.manifest.tag : release.tag_name || target.releaseTag;

  report("preflight", "running");
  try {
    const detail = await verifyDeploymentAccess(creds);
    report("preflight", "success", detail);
  } catch (error) {
    const message = messageOf(error);
    report("preflight", "failed", message);
    throw new DeployError("preflight", message);
  }

  const databaseId = await guarded("d1", report, () => getOrCreateDatabase(apiToken, accountId, target.dbName));

  await guarded("r2", report, async () => {
    await getOrCreateBucket(apiToken, accountId, target.bucketName);
    if (creds.r2AccessKeyId && creds.r2SecretAccessKey) {
      const verified = await verifyR2Keys({
        accountId,
        bucketName: target.bucketName,
        accessKeyId: creds.r2AccessKeyId,
        secretAccessKey: creds.r2SecretAccessKey,
      });
      if (!verified.ok) throw new Error(verified.message || "R2 access key pair didn't verify against the bucket");
    }
  });

  await guarded("schema", report, async () => {
    const sql = await fetchSchemaSql(target.sourceRepo, tag);
    await runQuery(apiToken, accountId, databaseId, sql);
  });

  const { manifest, files, workerBytes, assetsManifest, assetHeaders } = await guarded("download", report, async () => {
    const { manifest, archive } = "kind" in release ? release : await fetchManifestAndArtifact(release);
    const files = await unpackArtifact(archive);
    const workerBytes = files.get(manifest.workerModule);
    if (!workerBytes) throw new DeployError("download", "Update artifact has no Worker module");
    const assetsManifest = JSON.parse(textFile(files, manifest.assetsManifest)) as AssetManifest;
    // Packages built before asset header rules existed simply omit the file.
    const assetHeaders = files.has("assets/_headers") ? textFile(files, "assets/_headers") : undefined;
    return { manifest, files, workerBytes, assetsManifest, assetHeaders };
  });

  // Read before the version upload — any new version clears the schedule, so
  // this is the last point the pre-upload list is still visible via the API.
  const existingCrons = target.mode === "overwrite" ? await readCrons(apiToken, accountId, script).catch(() => []) : [];

  // A full rebuild drops the script and redeploys it as if it were new, so the
  // version upload below has to declare the complete binding set rather than
  // inherit one. D1 and R2 are untouched: the library and every setting stored
  // in the database survive.
  const rebuilding = target.mode === "overwrite" && target.fullRebuild;
  let preservedInstanceId = "";
  let restoredDomains: CustomDomain[] = [];
  if (rebuilding) {
    await guarded("rebuild", report, async () => {
      preservedInstanceId = await readInstanceId(apiToken, accountId, script).catch(() => "");
      restoredDomains = await listCustomDomains(apiToken, accountId, script).catch(() => []);
      await deleteScript(apiToken, accountId, script);
    });
  } else {
    report("rebuild", "success", "Full rebuild not requested");
  }

  const assetJwt = await guarded("assets", report, () => uploadAssets(apiToken, accountId, script, files, assetsManifest));

  const versionId = await guarded("worker", report, () =>
    uploadWorkerVersion({
      token: apiToken,
      accountId,
      script,
      workerModule: manifest.workerModule,
      workerBytes,
      assetJwt,
      assetHeaders,
      bucketName: target.bucketName,
      compatibilityDate: manifest.compatibilityDate,
      compatibilityFlags: manifest.compatibilityFlags,
      mode: rebuilding ? "fresh" : target.mode,
      fresh:
        target.mode === "fresh" || rebuilding
          ? {
              databaseId,
              bucketName: target.bucketName,
              workerName: target.workerName,
              version: manifest.version,
              buildTime: manifest.buildTime,
              // Keeping the identity keeps the D1 rows that attribute song
              // sources to this instance pointing at it.
              instanceId: preservedInstanceId || crypto.randomUUID(),
            }
          : undefined,
      overwriteVersion: target.mode === "overwrite" && !rebuilding ? { version: manifest.version, buildTime: manifest.buildTime } : undefined,
    }),
  );

  let domainFailures: string[] = [];
  await guarded("deploy", report, async () => {
    await switchTraffic(apiToken, accountId, script, versionId);
    if (restoredDomains.length > 0) domainFailures = await restoreCustomDomains(apiToken, accountId, script, restoredDomains);
  });
  if (domainFailures.length > 0) report("deploy", "success", `Custom domains to re-attach by hand: ${domainFailures.join(", ")}`);

  await guarded("secrets", report, async () => {
    await pushSecret(apiToken, accountId, script, "WORK_UPLOAD_HMAC_KEY", generateHmacKeyBase64());
    await pushSecret(apiToken, accountId, script, "CF_ACCOUNT_ID", accountId);
    await pushSecret(apiToken, accountId, script, "CF_API_TOKEN", apiToken);
    // Optional R2 keys enable direct presigned playback. Without them the
    // complete installation still uses the normal Worker proxy path.
    if (creds.r2AccessKeyId && creds.r2SecretAccessKey) {
      await pushSecret(apiToken, accountId, script, "R2_ACCESS_KEY_ID", creds.r2AccessKeyId);
      await pushSecret(apiToken, accountId, script, "R2_SECRET_ACCESS_KEY", creds.r2SecretAccessKey);
    }
    // worker/src/endpoints/subsonic/media.ts reads the actual bucket name
    // from the R2_BUCKET_NAME var (set as part of the "worker" step above,
    // see workerVersion.ts) rather than a hardcoded literal, so presign
    // works for any bucket name.
    if (creds.r2AccessKeyId && creds.r2SecretAccessKey) {
      await runQuery(
        apiToken,
        accountId,
        databaseId,
        "UPDATE feature_strings SET value = '1', updated_at = unixepoch() WHERE key = 'enable_r2_presign'",
      );
    }
  });

  await guarded("cron", report, () => setCron(apiToken, accountId, script, existingCrons.length > 0 ? existingCrons : [DEFAULT_CRON]));

  const admin = target.mode === "fresh" || target.resetAdmin
    ? await guarded("admin", report, () => createSuperadmin(apiToken, accountId, databaseId, target.adminUsername, target.adminPassword))
    : undefined;
  if (!admin) report("admin", "success", "Existing superadmin preserved");

  const url = target.domain ? `https://${target.domain}` : "";
  await guarded("health", report, async () => {
    // No custom domain means no known URL to probe: constructing the
    // *.workers.dev URL needs the account's subdomain, which isn't in
    // CONTRACT.md's allowlist (no GET .../workers/subdomain route).
    if (!url) return;
    await probeReachable(`${url}/edgesonic/version`);
    // Best-effort only (see health.ts) — never throws, a dark result still
    // reports success so it doesn't mask an otherwise-complete deployment.
  });

  return { accountId, url, adminUsername: admin?.username, adminPassword: admin?.password, version: manifest.version };
}
