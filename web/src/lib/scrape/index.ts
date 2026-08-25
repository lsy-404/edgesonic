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

// Metadata scrape aggregator.
//
// Drives the per-source adapters (netease/qmusic/kugou) according to the
// Settings-managed priority list. Each source falls back to the Worker proxy
// when direct CORS fails (see netease.ts:tryDirectThenProxy).
//
// Public surface (used by ScrapeButton.vue):
//  - searchAll({ query, sources, proxyFetch }) → SearchResponse
//  - fetchLyric({ source, songId, proxyFetch })
//  - submitResult({ result, songMasterId?, mode? }, authPost) → audit row id
//
// `proxyFetch` is injected by the caller (api.ts useAuth().authPost wrapped
// to POST /rest/scrapeMetadata). This keeps the adapters dependency-light:
// they don't import api.ts directly, which makes them testable + portable.

import * as netease from "./netease";
import * as qmusic from "./qmusic";
import * as kugou from "./kugou";
import * as lrc from "./lrc";
import type {
  ScrapeResult,
  ScrapeSource,
  SearchResponse,
} from "./types";
import type { ProxyFn } from "./netease";

export type { ScrapeResult, ScrapeSource, SearchResponse } from "./types";
export type { ProxyFn } from "./netease";

const ADAPTERS: Record<ScrapeSource, {
  search: (q: string, p: ProxyFn) => Promise<ScrapeResult[]>;
  fetchLyric: (id: string, p: ProxyFn) => Promise<string>;
  resolve?: (result: ScrapeResult, p: ProxyFn) => Promise<ScrapeResult>;
} | undefined> = {
  lrc: { search: lrc.search, fetchLyric: lrc.fetchLyric, resolve: lrc.resolve },
  netease: { search: netease.search, fetchLyric: netease.fetchLyric },
  qmusic: { search: qmusic.search, fetchLyric: qmusic.fetchLyric },
  kugou: { search: kugou.search, fetchLyric: kugou.fetchLyric },
  // No kuwo/migu adapters ship today; the keys exist in types so the
  // Settings UI can still validate user input. Aggregator silently skips them.
  kuwo: undefined,
  migu: undefined,
};

interface SearchOpts {
  query: string;
  sources: ScrapeSource[];
  proxyFetch: ProxyFn;
  /** Per-source limit (we keep ≤ 20 by upstream API design). */
  perSourceLimit?: number;
  /** Optional metadata gives ranking a stronger artist/title signal. */
  current?: Partial<Pick<ScrapeResult, "title" | "artist" | "album">>;
}

/** Fan-out enabled sources concurrently, then rank the combined result set. */
export async function searchAll(opts: SearchOpts): Promise<SearchResponse> {
  const limit = opts.perSourceLimit ?? 10;
  const jobs = opts.sources.map(async (src) => {
    const ad = ADAPTERS[src];
    if (!ad) return { source: src, rows: [] as ScrapeResult[] };
    const rows = await ad.search(opts.query, opts.proxyFetch);
    return { source: src, rows: rows.slice(0, limit) };
  });
  const settled = await Promise.allSettled(jobs);
  const errors: Array<{ source: ScrapeSource; error: string }> = [];
  const results: ScrapeResult[] = [];
  settled.forEach((item, index) => {
    const source = opts.sources[index];
    if (item.status === "fulfilled") results.push(...item.value.rows);
    else errors.push({ source, error: item.reason instanceof Error ? item.reason.message : String(item.reason) });
  });
  const queryFields = [opts.query, opts.current?.title, opts.current?.artist, opts.current?.album].filter((value): value is string => Boolean(value)).map(normalise);
  return { results: results.map((row, index) => ({ row, index, score: matchScore(row, queryFields) })).sort((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.row), errors };
}

function normalise(value: string): string { return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, " ").trim(); }
function matchScore(row: ScrapeResult, fields: string[]): number {
  const title = normalise(row.title); const artist = normalise(row.artist); const album = normalise(row.album || "");
  const haystack = `${title} ${artist} ${album}`;
  let score = 0;
  for (const field of fields) {
    if (!field) continue;
    if (title === field) score += 100;
    else if (title.includes(field)) score += 60;
    else if (haystack.includes(field)) score += 25;
    for (const token of field.split(" ").filter(Boolean)) if (haystack.includes(token)) score += 3;
  }
  return score;
}

interface LyricOpts {
  source: ScrapeSource;
  songId: string;
  proxyFetch: ProxyFn;
}

export async function fetchLyric(opts: LyricOpts): Promise<string> {
  const ad = ADAPTERS[opts.source];
  if (!ad) throw new Error(`scrape source ${opts.source} not supported`);
  return ad.fetchLyric(opts.songId, opts.proxyFetch);
}

export async function resolveResult(result: ScrapeResult, proxyFetch: ProxyFn): Promise<ScrapeResult> {
  return (await ADAPTERS[result.source]?.resolve?.(result, proxyFetch)) || result;
}

// ===========================================================================
// Submit + history helpers — thin wrappers around the W endpoints.
// Callers pass their authenticated POST/GET functions in to avoid coupling
// the adapters to api.ts.
// ===========================================================================
export interface SubmitOpts {
  songMasterId?: string;
  source: ScrapeSource;
  songId?: string;
  query?: string;
  result: ScrapeResult;
  mode?: "tags" | "cover" | "both";
}

export async function submitResult(
  opts: SubmitOpts,
  authPost: (path: string, body: unknown) => Promise<string>,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  return JSON.parse(await authPost("submitScrape", {
    songMasterId: opts.songMasterId,
    source: opts.source,
    songId: opts.songId,
    query: opts.query,
    result: opts.result,
    mode: opts.mode || "tags",
  }));
}

export async function getHistory(
  params: { limit?: number; offset?: number; songMasterId?: string },
  authFetch: (path: string, q?: Record<string, string>) => Promise<string>,
): Promise<unknown> {
  const q: Record<string, string> = {};
  if (params.limit != null) q.limit = String(params.limit);
  if (params.offset != null) q.offset = String(params.offset);
  if (params.songMasterId) q.songMasterId = params.songMasterId;
  return JSON.parse(await authFetch("scrapeHistory", q));
}

/**
 * Build a `ProxyFn` from an authenticated POST function. ScrapeButton.vue
 * wires this up by passing `useAuth().authPost`.
 */
export function makeProxyFetch(
  authPost: (path: string, body: unknown) => Promise<string>,
): ProxyFn {
  return async (req) => JSON.parse(await authPost("scrape", req));
}
