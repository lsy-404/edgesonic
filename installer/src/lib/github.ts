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

// api.github.com and raw.githubusercontent.com both send CORS headers, so
// these calls go straight from the browser — no relay involved.

import type { GithubRelease } from "../../../shared/autoupdate";

export async function fetchReleases(repo: string): Promise<GithubRelease[]> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=50`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed (HTTP ${response.status})`);
  }
  return (await response.json()) as GithubRelease[];
}

export async function fetchSchemaSql(repo: string, tag: string): Promise<string> {
  const response = await fetch(`https://raw.githubusercontent.com/${repo}/${tag}/worker/migrations/Schema.sql`);
  if (!response.ok) {
    throw new Error(`Couldn't fetch Schema.sql for ${tag} (HTTP ${response.status})`);
  }
  return await response.text();
}
