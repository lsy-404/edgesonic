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

// Release eligibility rules shared by the Worker and the SPA.
//
// The SPA queries GitHub from the browser so the release list is billed to the
// visitor's own rate-limit budget instead of the Cloudflare egress address the
// Worker shares with every other tenant. Both sides must reach the same verdict
// about a release, so the version maths lives here rather than being restated
// per side. Keep this file free of Worker and DOM globals.

export const GITHUB_REPO = "wuyilingwei/edgesonic";
export const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}`;

export const UPDATE_ARTIFACT_NAME = "edgesonic-update.tar.gz";
export const UPDATE_MANIFEST_NAME = "edgesonic-update-manifest.json";

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
  raw: string;
}

export interface GithubAsset {
  name?: string;
  browser_download_url?: string;
  size?: number;
}

export interface GithubRelease {
  tag_name?: string;
  name?: string;
  published_at?: string | null;
  prerelease?: boolean;
  draft?: boolean;
  html_url?: string;
  assets?: GithubAsset[];
}

export interface ReleaseOption {
  tag: string;
  version: string;
  name: string;
  publishedAt: string | null;
  prerelease: boolean;
  htmlUrl: string;
  hasArtifact: boolean;
  isMajor: boolean;
  eligible: boolean;
  reason: "ok" | "not-newer" | "downgrade" | "major-confirmation-required" | "artifact-missing" | "invalid-version";
}

export interface ReleaseListing {
  ok: true;
  currentVersion: string;
  defaultTag: string | null;
  releases: ReleaseOption[];
}

export const ZERO_VERSION: Semver = { major: 0, minor: 0, patch: 0, prerelease: "", raw: "0.0.0" };

export function parseSemver(value: string): Semver | null {
  const raw = value.trim().replace(/^v/, "");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw);
  if (!match) return null;
  const normalized = `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}`;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || "",
    raw: normalized,
  };
}

function comparePrerelease(a: string, b: string): number {
  const aParts = a.split(".");
  const bParts = b.split(".");
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index++) {
    if (index >= aParts.length) return -1;
    if (index >= bParts.length) return 1;
    const left = aParts[index];
    const right = bParts[index];
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const numericComparison = Number(left) - Number(right);
      if (numericComparison !== 0) return numericComparison;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (left !== right) {
      return left.localeCompare(right);
    }
  }
  return 0;
}

export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function normalizeTag(tag: string): string {
  const trimmed = tag.trim();
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

export function classifyVersionUpdate(current: Semver, target: Semver, majorDeclared: boolean, majorConfirmed: boolean): ReleaseOption["reason"] {
  if (target.major < current.major) return "downgrade";
  const comparison = compareSemver(target, current);
  if (comparison <= 0) return "not-newer";
  if (target.major > current.major && (!majorDeclared || !majorConfirmed)) return "major-confirmation-required";
  return "ok";
}

// Only accept assets served from this repository's release downloads. The
// Worker relies on this when it fetches the artifact, so the check must not be
// relaxed to whatever URL a release body happens to carry.
export function assetOf(release: GithubRelease, name: string): GithubAsset | null {
  const asset = (release.assets || []).find((candidate) => candidate.name === name);
  if (!asset?.browser_download_url) return null;
  try {
    const url = new URL(asset.browser_download_url);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      !url.pathname.startsWith(`/${GITHUB_REPO}/releases/download/`)
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return asset;
}

export function hasUpdateArtifact(release: GithubRelease): boolean {
  return !!assetOf(release, UPDATE_ARTIFACT_NAME) && !!assetOf(release, UPDATE_MANIFEST_NAME);
}

/** Rank releases against the running version, newest first. */
export function buildReleaseOptions(releases: GithubRelease[], current: Semver): ReleaseListing {
  const parsed = releases
    .filter((release) => !release.draft && typeof release.tag_name === "string")
    .map((release) => {
      const tag = release.tag_name || "";
      const version = parseSemver(tag);
      const artifact = hasUpdateArtifact(release);
      const base: ReleaseOption = {
        tag,
        version: version?.raw || tag.replace(/^v/, ""),
        name: release.name || tag,
        publishedAt: release.published_at || null,
        prerelease: !!release.prerelease || !!version?.prerelease,
        htmlUrl: release.html_url || `https://github.com/${GITHUB_REPO}/releases/tag/${tag}`,
        hasArtifact: artifact,
        isMajor: !!version && version.major > current.major,
        eligible: false,
        reason: "invalid-version",
      };
      if (!version) return base;
      const reason = classifyVersionUpdate(current, version, false, false);
      return {
        ...base,
        isMajor: version.major > current.major,
        eligible: reason === "ok" && artifact,
        reason: artifact ? reason : "artifact-missing",
      };
    })
    .filter((release) => !!parseSemver(release.version))
    .sort((a, b) => {
      const av = parseSemver(a.version);
      const bv = parseSemver(b.version);
      return av && bv ? compareSemver(bv, av) : 0;
    });
  const stable = parsed.find((release) => !release.prerelease && release.hasArtifact);
  return {
    ok: true,
    currentVersion: current.raw,
    defaultTag: stable?.tag || parsed[0]?.tag || null,
    releases: parsed,
  };
}
