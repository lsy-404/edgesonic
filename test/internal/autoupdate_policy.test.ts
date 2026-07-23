// SPDX-License-Identifier: AGPL-3.0-or-later

import { classifyVersionUpdate, compareSemver, listUpdates, parseSemver } from "../../worker/src/utils/autoupdate";

let failures = 0;
function assert(condition: boolean, message: string) {
  if (condition) console.log(`  OK ${message}`);
  else {
    failures++;
    console.error(`  FAIL ${message}`);
  }
}

function version(value: string) {
  const parsed = parseSemver(value);
  if (!parsed) throw new Error(`invalid test version: ${value}`);
  return parsed;
}

console.log("Auto-update version policy:");
assert(classifyVersionUpdate(version("1.2.5"), version("1.3.0"), false, false) === "ok", "same-Major Minor update is allowed");
assert(classifyVersionUpdate(version("1.2.5"), version("1.2.6"), false, false) === "ok", "same-Major Patch update is allowed");
assert(classifyVersionUpdate(version("1.2.5"), version("2.0.0"), false, false) === "major-confirmation-required", "Major update is rejected by default");
assert(classifyVersionUpdate(version("1.2.5"), version("2.0.0"), true, false) === "major-confirmation-required", "Major declaration alone does not bypass confirmation");
assert(classifyVersionUpdate(version("1.2.5"), version("2.0.0"), true, true) === "ok", "declared and confirmed Major update is allowed");
assert(classifyVersionUpdate(version("2.0.0"), version("1.9.9"), true, true) === "downgrade", "downgrade is rejected");
assert(classifyVersionUpdate(version("1.2.5"), version("1.2.5"), false, false) === "not-newer", "same version is rejected");
assert(compareSemver(version("1.0.0-alpha.2"), version("1.0.0-alpha.10")) < 0, "numeric prerelease identifiers use numeric ordering");
assert(compareSemver(version("1.0.0-alpha"), version("1.0.0-alpha.1")) < 0, "shorter prerelease identifiers sort first");
assert(version("v1.2.3+build.7").raw === "1.2.3", "build metadata does not change the normalized version");

async function testReleaseListing() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/releases?per_page=50")) {
      return Response.json([
        { tag_name: "v1.3.0", assets: [{ name: "edgesonic-update.tar.gz", browser_download_url: "https://github.com/wuyilingwei/edgesonic/releases/download/v1.3.0/edgesonic-update.tar.gz" }] },
        { tag_name: "v1.5.0", assets: [
          { name: "edgesonic-update.tar.gz", browser_download_url: "https://example.test/v1.5.0.tar.gz" },
          { name: "edgesonic-update-manifest.json", browser_download_url: "https://example.test/v1.5.0.json" },
        ] },
        { tag_name: "v2.0.0", assets: [
          { name: "edgesonic-update.tar.gz", browser_download_url: "https://github.com/wuyilingwei/edgesonic/releases/download/v2.0.0/edgesonic-update.tar.gz" },
          { name: "edgesonic-update-manifest.json", browser_download_url: "https://github.com/wuyilingwei/edgesonic/releases/download/v2.0.0/edgesonic-update-manifest.json" },
        ] },
        { tag_name: "v1.4.0", assets: [
          { name: "edgesonic-update.tar.gz", browser_download_url: "https://github.com/wuyilingwei/edgesonic/releases/download/v1.4.0/edgesonic-update.tar.gz" },
          { name: "edgesonic-update-manifest.json", browser_download_url: "https://github.com/wuyilingwei/edgesonic/releases/download/v1.4.0/edgesonic-update-manifest.json" },
        ] },
        { tag_name: "v3.0.0-beta.1", prerelease: false, assets: [
          { name: "edgesonic-update.tar.gz", browser_download_url: "https://github.com/wuyilingwei/edgesonic/releases/download/v3.0.0-beta.1/edgesonic-update.tar.gz" },
          { name: "edgesonic-update-manifest.json", browser_download_url: "https://github.com/wuyilingwei/edgesonic/releases/download/v3.0.0-beta.1/edgesonic-update-manifest.json" },
        ] },
      ]);
    }
    throw new Error(`unexpected fetch: ${String(input)}`);
  };

  try {
    const listing = await listUpdates({ EDGESONIC_VERSION: "1.2.5" } as Env, "https://example.test");
    assert(listing.defaultTag === "v2.0.0", "latest stable release is selected by default");
    assert(listing.releases.find((release) => release.tag === "v1.4.0")?.eligible === true, "same-Major release with both API assets is eligible");
    assert(listing.releases.find((release) => release.tag === "v2.0.0")?.reason === "major-confirmation-required", "Major release is listed but gated");
    assert(listing.releases.find((release) => release.tag === "v1.3.0")?.reason === "artifact-missing", "incomplete release assets are marked unavailable");
    assert(listing.releases.find((release) => release.tag === "v3.0.0-beta.1")?.prerelease === true, "semantic prerelease tags are not treated as stable");
    assert(listing.releases.find((release) => release.tag === "v1.5.0")?.reason === "artifact-missing", "non-GitHub asset URLs are rejected");
  } catch (error) {
    failures++;
    console.error(`  FAIL release listing: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void testReleaseListing().then(() => {
  if (failures > 0) process.exitCode = 1;
});
