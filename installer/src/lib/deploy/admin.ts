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

import { runQuery } from "./d1";
import { generatePassword, sha256Hex } from "./crypto";

export const ADMIN_USERNAME = "admin";

export async function createSuperadmin(token: string, accountId: string, databaseId: string, requestedPassword?: string): Promise<string> {
  const password = requestedPassword || generatePassword(10);
  const hash = await sha256Hex(new TextEncoder().encode(password));
  await runQuery(
    token,
    accountId,
    databaseId,
    "INSERT INTO users (username, master_password, level, enabled) VALUES (?, ?, 3, 1) " +
      "ON CONFLICT(username) DO UPDATE SET master_password = excluded.master_password, level = 3, enabled = 1",
    [ADMIN_USERNAME, hash],
  );
  return password;
}
