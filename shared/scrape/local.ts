// SPDX-License-Identifier: AGPL-3.0-or-later
import { searchAll, resolveResult, rankResults } from "./index";
import type { ScrapeResult, ScrapeSource, SearchResponse, ProxyFn } from "./index";
import { proxyFetch } from "./transport";

export const DEFAULT_SOURCES: ScrapeSource[] = ["lrc", "netease", "qmusic", "kugou"];
export interface MetadataSearchInput {
  query: string;
  sources?: ScrapeSource[];
  current?: Partial<Pick<ScrapeResult, "title" | "artist" | "album">>;
  limit?: number;
}
function directProxy(signal: AbortSignal): ProxyFn {
  const proxy: ProxyFn = async (request) => {
    try { return { ok: true, data: await proxyFetch(request.source, request.intent, request, signal) }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  };
  proxy.allowDirectFallback = false;
  return proxy;
}
async function bounded<T>(run: (proxy: ProxyFn) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(directProxy(controller.signal)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("provider timed out")); }, 12000); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
export function validateSources(value: unknown): ScrapeSource[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > DEFAULT_SOURCES.length || value.some((v) => !DEFAULT_SOURCES.includes(v))) {
    throw new Error("sources must contain supported providers");
  }
  return [...new Set(value)] as ScrapeSource[];
}
export async function searchMetadata(input: MetadataSearchInput): Promise<SearchResponse> {
  if (!input || typeof input.query !== "string" || !input.query.trim() || input.query.length > 200) throw new Error("query must be 1–200 characters");
  const sources = validateSources(input.sources === undefined ? DEFAULT_SOURCES : input.sources);
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20)) throw new Error("limit must be an integer between 1 and 20");
  if (input.current !== undefined && (!input.current || typeof input.current !== "object" || Array.isArray(input.current) || Object.values(input.current).some((v) => typeof v !== "string" || v.length > 200))) throw new Error("invalid current metadata");
  const responses = await Promise.all(sources.map(async (source) => {
    try { return await bounded((proxyFetch) => searchAll({ query: input.query.trim(), sources: [source], proxyFetch, perSourceLimit: input.limit ?? 10, current: input.current })); }
    catch (error) { return { results: [], errors: [{ source, error: error instanceof Error ? error.message : String(error) }] }; }
  }));
  return { results: rankResults(responses.flatMap((r) => r.results), input.query, input.current).slice(0, input.limit ?? 20), errors: responses.flatMap((r) => r.errors) };
}
export async function resolveMetadata(input: { result: ScrapeResult }): Promise<ScrapeResult> {
  const r = input?.result;
  if (!r || typeof r !== "object" || !DEFAULT_SOURCES.includes(r.source) || typeof r.songId !== "string" || r.songId.length > 160 || typeof r.title !== "string" || r.title.length > 500 || typeof r.artist !== "string" || r.artist.length > 500) throw new Error("invalid result");
  if (r.source === "netease" && !/^\d{1,30}$/.test(r.songId) || r.source === "qmusic" && !/^[A-Za-z0-9]{6,80}$/.test(r.songId) || r.source === "kugou" && !/^[A-F0-9]{32}$/i.test(r.songId) || r.source === "lrc" && !/^[A-Za-z0-9_-]{1,160}$/.test(r.songId)) throw new Error("invalid songId");
  if (r.source === "lrc") {
    const raw = r.raw as { slug?: unknown; songTitle?: unknown } | undefined;
    if (!raw || raw.slug !== r.songId || typeof raw.songTitle !== "string" || raw.songTitle.length > 500) throw new Error("invalid lrc result");
  }
  return bounded((proxyFetch) => resolveResult(r, proxyFetch));
}
