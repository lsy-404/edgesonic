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

import { GITHUB_API, GITHUB_REPO, type GithubRelease } from "../../../shared/autoupdate";

async function githubJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed (HTTP ${response.status})`);
  }
  return (await response.json()) as T;
}

// The repository is fixed: release assets only pass assetOf()'s origin check
// when they are served from this repository's own release downloads, so a
// deploy could never have come from anywhere else anyway.
export async function fetchReleases(): Promise<GithubRelease[]> {
  // The list endpoint is the flakier of the two: GitHub API incidents have had
  // it answer 200 with an empty array, and later serve an HTML error page the
  // browser rejects outright, while single-release lookups kept working. Treat
  // an empty list and a failed request the same way and fall back to the
  // latest release so a deploy is still possible.
  try {
    const releases = await githubJson<GithubRelease[]>(`${GITHUB_API}/releases?per_page=50`);
    if (releases.length > 0) return releases;
  } catch {
    // Fall through to the single-release lookup below.
  }
  // A repository that genuinely has no releases 404s here, so the caller ends
  // up with the same empty list either way.
  return [await githubJson<GithubRelease>(`${GITHUB_API}/releases/latest`)];
}

export async function fetchSchemaSql(tag: string): Promise<string> {
  const response = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/${tag}/worker/migrations/Schema.sql`);
  if (!response.ok) {
    throw new Error(`Couldn't fetch Schema.sql for ${tag} (HTTP ${response.status})`);
  }
  return await response.text();
}
