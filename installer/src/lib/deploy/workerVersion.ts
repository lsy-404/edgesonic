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

import { callCfJson, callCfMultipart } from "../relay";

type Binding = Record<string, unknown>;

interface FreshBindingsInput {
  databaseId: string;
  bucketName: string;
  workerName: string;
  version: string;
  buildTime: string;
  instanceId: string;
}

// A brand-new script has no previously-deployed version to inherit bindings
// from via keep_bindings, so this declares the full set wrangler.toml.example
// needs at runtime: DB (d1), MUSIC_BUCKET (r2), ASSETS, and the plain_text
// vars worker/src/types/env.d.ts reads unconditionally. CF_ACCOUNT_ID is
// intentionally absent — it's pushed as a Workers Secret, not a var. Images
// is safe to bind for every installation: cover art falls back to original
// bytes until the selected zone enables Transformations. The Sandbox
// container/DO remains excluded because a browser cannot build its image.
export function freshBindings(input: FreshBindingsInput): Binding[] {
  return [
    { type: "d1", name: "DB", database_id: input.databaseId },
    { type: "r2_bucket", name: "MUSIC_BUCKET", bucket_name: input.bucketName },
    // R2Bucket bindings don't expose their own bucket name at runtime — this
    // mirrors the binding above so media.ts can sign presigned URLs against
    // whatever bucket name was actually chosen, not just the historical
    // "edgesonic-music" default.
    { type: "plain_text", name: "R2_BUCKET_NAME", text: input.bucketName },
    { type: "plain_text", name: "INSTANCE_ID", text: input.instanceId },
    { type: "plain_text", name: "MAX_PROXY_DEPTH", text: "3" },
    { type: "plain_text", name: "WORKER_VERSION", text: input.version },
    { type: "plain_text", name: "EDGESONIC_VERSION", text: input.version },
    { type: "plain_text", name: "EDGESONIC_BUILD_TIME", text: input.buildTime },
    { type: "plain_text", name: "WORKER_NAME", text: input.workerName },
    { type: "images", name: "IMAGES" },
    { type: "assets", name: "ASSETS" },
  ];
}

const KEEP_BINDING_TYPES = ["plain_text", "json", "secret_text", "secret_key", "kv_namespace", "d1", "r2_bucket", "durable_object_namespace", "images", "assets"];

interface UploadVersionInput {
  token: string;
  accountId: string;
  script: string;
  workerModule: string;
  workerBytes: Uint8Array;
  assetJwt: string;
  assetHeaders?: string;
  bucketName: string;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  mode: "fresh" | "overwrite";
  keepContainer?: boolean;
  fresh?: FreshBindingsInput;
  overwriteVersion?: { version: string; buildTime: string };
}

export async function uploadWorkerVersion(input: UploadVersionInput): Promise<string> {
  const bindings: Binding[] =
    input.mode === "fresh"
      ? freshBindings(input.fresh as FreshBindingsInput)
      : [
          { type: "plain_text", name: "WORKER_VERSION", text: input.overwriteVersion?.version },
          { type: "plain_text", name: "EDGESONIC_VERSION", text: input.overwriteVersion?.version },
          { type: "plain_text", name: "EDGESONIC_BUILD_TIME", text: input.overwriteVersion?.buildTime },
          // Explicitly set (not just carried over via keep_bindings) so a
          // recovery install self-heals this var even if the instance being
          // recovered predates it, or was renamed away from the default.
          { type: "plain_text", name: "R2_BUCKET_NAME", text: input.bucketName },
          { type: "assets", name: "ASSETS" },
        ];

  // config._headers carries the package's _headers file verbatim — Cloudflare
  // parses it server-side. It sets Content-Type from the request path, which
  // is the only way to repair assets whose stored type is empty: those are
  // deduplicated by content hash and never re-uploaded.
  const assets: Record<string, unknown> = { jwt: input.assetJwt };
  if (input.assetHeaders) assets.config = { _headers: input.assetHeaders };

  const metadata: Record<string, unknown> = {
    main_module: input.workerModule,
    bindings,
    compatibility_date: input.compatibilityDate || "2025-05-24",
    compatibility_flags: input.compatibilityFlags || ["nodejs_compat"],
    assets,
  };
  if (input.mode === "overwrite") {
    metadata.keep_bindings = KEEP_BINDING_TYPES;
  }
  // Ported from worker/src/utils/autoupdate.ts's executeUpdate: a script that
  // already has the Sandbox Durable Object registered orphans it (Cloudflare
  // error 10064) if a new version omits this. Declaring one the script never
  // had is rejected instead, since the image can only be built by wrangler on
  // a machine with Docker — hence the caller decides, from what the live
  // script actually has plus the operator's choice.
  if (input.keepContainer) metadata.containers = [{ class_name: "Sandbox" }];

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata");
  form.append(input.workerModule, new Blob([input.workerBytes.buffer as ArrayBuffer], { type: "application/javascript+module" }), input.workerModule);

  const result = await callCfMultipart<{ id?: string }>(
    input.token,
    `/accounts/${input.accountId}/workers/scripts/${encodeURIComponent(input.script)}/versions`,
    form,
    "Workers Scripts Edit",
  );
  if (!result.id) throw new Error("Cloudflare did not return a Worker version id");
  return result.id;
}

export async function switchTraffic(token: string, accountId: string, script: string, versionId: string): Promise<void> {
  await callCfJson(
    token,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/deployments`,
    { method: "POST", body: JSON.stringify({ strategy: "percentage", versions: [{ percentage: 100, version_id: versionId }] }) },
    "Workers Scripts Edit",
  );
}

export async function scriptExists(token: string, accountId: string, script: string): Promise<boolean> {
  return (await listScriptNames(token, accountId)).includes(script);
}

export async function listScriptNames(token: string, accountId: string): Promise<string[]> {
  const list = await callCfJson<Array<{ id?: string }>>(token, `/accounts/${accountId}/workers/scripts`, undefined, "Workers Scripts Edit");
  return list.map((entry) => entry.id || "").filter(Boolean);
}

export async function readCrons(token: string, accountId: string, script: string): Promise<string[]> {
  const result = await callCfJson<{ schedules?: Array<{ cron?: string }> }>(
    token,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/schedules`,
    undefined,
    "Workers Scripts Edit",
  );
  return (result.schedules || []).map((row) => row.cron || "").filter(Boolean);
}
