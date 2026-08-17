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

// Deleting the script drops everything attached to it: bindings, secrets,
// schedules, Durable Object namespaces, its static asset store and its custom
// domains. D1 and R2 are separate resources and survive untouched, so the
// library itself is never at risk. Secrets and schedules are rewritten by the
// normal deploy steps; what has to be rescued first is whatever the deploy
// cannot regenerate — the instance identity and the custom domains.

import { callCfJson, callCfNoContent } from "../relay";

export interface CustomDomain {
  hostname: string;
  zoneId: string;
  environment?: string;
}

interface ScriptSettings {
  bindings?: Array<{ type?: string; name?: string; text?: string }>;
}

interface DomainRow {
  hostname?: string;
  zone_id?: string;
  service?: string;
  environment?: string;
}

/**
 * INSTANCE_ID is the anti-loop chain marker and the OpenSubsonic server id,
 * and D1 rows attribute song sources to it — a rebuilt Worker that generates a
 * fresh one would make the instance's own songs look like a peer's.
 */
export async function readInstanceId(token: string, accountId: string, script: string): Promise<string> {
  const settings = await callCfJson<ScriptSettings>(
    token,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/settings`,
    undefined,
    "Workers Scripts Edit",
  );
  const binding = (settings.bindings || []).find((entry) => entry.type === "plain_text" && entry.name === "INSTANCE_ID");
  return binding?.text || "";
}

export async function listCustomDomains(token: string, accountId: string, script: string): Promise<CustomDomain[]> {
  const rows = await callCfJson<DomainRow[]>(token, `/accounts/${accountId}/workers/domains`, undefined, "Workers Scripts Edit");
  return (rows || [])
    .filter((row) => row.service === script && row.hostname && row.zone_id)
    .map((row) => ({ hostname: row.hostname as string, zoneId: row.zone_id as string, environment: row.environment }));
}

export async function deleteScript(token: string, accountId: string, script: string): Promise<void> {
  await callCfNoContent(
    token,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}?force=true`,
    { method: "DELETE" },
    "Workers Scripts Edit",
  );
}

/** Best effort: a domain that refuses to re-attach is reported, never fatal — the deployment itself is already live. */
export async function restoreCustomDomains(token: string, accountId: string, script: string, domains: CustomDomain[]): Promise<string[]> {
  const failed: string[] = [];
  for (const domain of domains) {
    try {
      await callCfJson(
        token,
        `/accounts/${accountId}/workers/domains`,
        {
          method: "PUT",
          body: JSON.stringify({
            hostname: domain.hostname,
            service: script,
            zone_id: domain.zoneId,
            environment: domain.environment || "production",
          }),
        },
        "Workers Scripts Edit",
      );
    } catch {
      failed.push(domain.hostname);
    }
  }
  return failed;
}
