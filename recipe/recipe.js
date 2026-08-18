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

// Deployment script for the browser wizard. Runs in a sandboxed iframe: every
// effect below is a capability call declared in recipe.json, and no Cloudflare
// credential is ever readable here.

const DEFAULT_CRON = "0 */1 * * *";
const ADMIN_UPSERT_SQL =
  "INSERT INTO users (username, master_password, level, enabled) VALUES (?, ?, 3, 1) " +
  "ON CONFLICT(username) DO UPDATE SET master_password = excluded.master_password, level = 3, enabled = 1";

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Optional host secrets have no value when the user left the fields empty, and
 * the script cannot see which. A rejected push is the only signal, so it is
 * read as "not configured" rather than a failure.
 */
async function pushOptionalHostValues(ctx, names) {
  for (const name of names) {
    try {
      await ctx.secrets.putHostValue(name);
    } catch {
      return false;
    }
  }
  return true;
}

export async function deploy(ctx) {
  const { mode, fullRebuild, live, domain, workerName, inputs } = ctx.ctx;

  await ctx.step("d1", "running");
  await ctx.d1.provision("db");
  await ctx.step("d1", "success");

  await ctx.step("r2", "running");
  const { bucketName } = await ctx.r2.provision("music");
  await ctx.step("r2", "success");

  await ctx.step("schema", "running");
  // Every statement is CREATE ... IF NOT EXISTS, so the same file is replayed
  // for both a fresh install and a recovery.
  await ctx.d1.query("db", await ctx.text("migrations/Schema.sql"));
  await ctx.step("schema", "success");

  // Deleting the script drops its bindings, secrets, schedules, asset store and
  // custom domains; D1 and R2 are separate resources and survive. The steps
  // below rewrite everything the deploy can regenerate, so only the domains
  // have to be carried across the deletion by hand.
  let domainsToRestore = [];
  if (fullRebuild) {
    await ctx.step("rebuild", "running");
    domainsToRestore = live.customDomains.slice();
    await ctx.worker.deleteScript();
    await ctx.step("rebuild", "success");
  } else {
    await ctx.step("rebuild", "skipped", "Full rebuild not requested");
  }

  await ctx.step("assets", "running");
  const assets = await ctx.assets.upload();
  await ctx.step("assets", "success");

  await ctx.step("worker", "running");
  // Keeping the live identity keeps the D1 rows that attribute song sources to
  // this instance pointing at it; a fresh install takes the generated one.
  const instanceId = trimmed(live.vars.INSTANCE_ID);
  const { versionId } = await ctx.worker.uploadVersion(
    instanceId ? { assets, extraVars: { INSTANCE_ID: instanceId } } : { assets },
  );
  await ctx.step("worker", "success");

  await ctx.step("deploy", "running");
  await ctx.worker.switchTraffic(versionId);
  const domainFailures = [];
  for (const hostname of domainsToRestore) {
    try {
      await ctx.domains.attach(hostname);
    } catch {
      domainFailures.push(hostname);
    }
  }
  // The deployment is already live, so a domain that refuses to re-attach is
  // reported rather than fatal.
  await ctx.step(
    "deploy",
    "success",
    domainFailures.length > 0 ? `Custom domains to re-attach by hand: ${domainFailures.join(", ")}` : undefined,
  );

  await ctx.step("secrets", "running");
  await ctx.secrets.put("WORK_UPLOAD_HMAC_KEY", await ctx.crypto.randomBase64(48));
  await ctx.secrets.putHostValue("CF_ACCOUNT_ID");
  await ctx.secrets.putHostValue("CF_API_TOKEN");
  const presign = await pushOptionalHostValues(ctx, ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]);
  if (presign) {
    // The Worker reads the bucket name from the R2_BUCKET_NAME var, so presign
    // works for whatever bucket name was chosen.
    await ctx.d1.query(
      "db",
      "UPDATE feature_strings SET value = '1', updated_at = unixepoch() WHERE key = 'enable_r2_presign'",
    );
  }
  await ctx.step("secrets", "success", presign ? `Presigned playback enabled for ${bucketName}` : "R2 direct-play keys not configured");

  await ctx.step("cron", "running");
  // A version upload clears whatever schedule was live, so this restores the
  // pre-deploy list, or the project default for an instance that had none.
  const crons = live.crons.length > 0 ? live.crons : [DEFAULT_CRON];
  await ctx.cron.set(crons);
  await ctx.step("cron", "success", crons.join(", "));

  const resetAdmin = inputs.reset_admin === true;
  if (mode === "fresh" || resetAdmin) {
    await ctx.step("admin", "running");
    const username = trimmed(inputs.admin_username) || "admin";
    const password = trimmed(inputs.admin_password) || (await ctx.crypto.password(12));
    const hash = await ctx.crypto.sha256Hex(password);
    await ctx.d1.query("db", ADMIN_UPSERT_SQL, [username, hash]);
    await ctx.result({
      credentials: [
        { label: "Superadmin username", value: username },
        { label: "Superadmin password", value: password, secret: true },
      ],
    });
    await ctx.step("admin", "success");
  } else {
    await ctx.step("admin", "skipped", "Existing superadmin preserved");
  }

  const url = domain ? `https://${domain}` : "";
  await ctx.step("health", "running");
  if (url) {
    // Best effort: an unreachable probe right after a traffic switch usually
    // means Cloudflare has not finished propagating, not a failed deployment.
    const probe = await ctx.probe.reachable(`${url}/edgesonic/version`);
    await ctx.step("health", "success", probe.ok ? `Answered with HTTP ${probe.status}` : "No answer yet — Cloudflare may still be propagating");
  } else {
    await ctx.step("health", "skipped", "No custom domain to probe");
  }

  await ctx.result({
    url,
    notes: [`Worker ${workerName} is serving version ${ctx.ctx.version}.`],
  });
}
