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

interface D1Database {
  uuid?: string;
  name?: string;
}

export async function getOrCreateDatabase(token: string, accountId: string, name: string): Promise<string> {
  const existing = await callCfJson<D1Database[]>(
    token,
    `/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}`,
    undefined,
    "D1 Edit",
  );
  const match = existing.find((db) => db.name === name && db.uuid);
  if (match?.uuid) return match.uuid;

  const created = await callCfJson<D1Database>(
    token,
    `/accounts/${accountId}/d1/database`,
    { method: "POST", body: JSON.stringify({ name }) },
    "D1 Edit",
  );
  if (!created.uuid) throw new Error("Cloudflare didn't return a database id");
  return created.uuid;
}

// D1's query endpoint accepts a semicolon-joined batch of statements in one
// call, so the whole Schema.sql (idempotent — every statement is
// CREATE TABLE/INDEX IF NOT EXISTS) can be replayed in a single request for
// both fresh and overwrite installs.
export async function runQuery(token: string, accountId: string, databaseId: string, sql: string, params?: unknown[]): Promise<void> {
  await callCfJson(
    token,
    `/accounts/${accountId}/d1/database/${databaseId}/query`,
    { method: "POST", body: JSON.stringify(params ? { sql, params } : { sql }) },
    "D1 Edit",
  );
}
