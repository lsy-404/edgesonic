// SPDX-License-Identifier: AGPL-3.0-or-later
import { getFeatureString } from "../utils/features";
import { DEFAULT_SOURCES, searchMetadata as searchDirect, resolveMetadata as resolveDirect, validateSources } from "../../../shared/scrape/local";
import type { MetadataSearchInput } from "../../../shared/scrape/local";
import type { ScrapeResult } from "../../../shared/scrape";

export async function searchMetadata(env: Env, input: MetadataSearchInput) {
  if (input?.sources !== undefined) return searchDirect(input);
  const raw = await getFeatureString(env, "scrape_enabled_sources", JSON.stringify(DEFAULT_SOURCES));
  let configured: unknown;
  try { configured = JSON.parse(raw); } catch { throw new Error("invalid configured metadata sources"); }
  if (!Array.isArray(configured)) throw new Error("invalid configured metadata sources");
  const enabled = configured.filter((source) => DEFAULT_SOURCES.includes(source));
  return searchDirect({ ...input, sources: validateSources(enabled) });
}
export async function resolveMetadata(_env: Env, input: { result: ScrapeResult }) { return resolveDirect(input); }
