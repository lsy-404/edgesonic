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

import { callCfJson } from "../relay";

export const DEFAULT_CRON = "0 */1 * * *";

// wrangler.toml.example deliberately declares no static [triggers] block (CF
// cron state is runtime-managed, see worker/CF_CRON.md), and every Worker
// version upload clears whatever schedule was live before it — this always
// runs after the version switch, restoring either the crons read before the
// upload (overwrite) or the project default (fresh install).
export async function setCron(token: string, accountId: string, script: string, crons: string[]): Promise<void> {
  if (crons.length === 0) return;
  await callCfJson(
    token,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/schedules`,
    { method: "PUT", body: JSON.stringify(crons.map((cron) => ({ cron }))) },
    "Workers Scripts Edit",
  );
}
