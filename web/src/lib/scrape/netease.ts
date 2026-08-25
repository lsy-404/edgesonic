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

// NetEase Music scrape adapter.
//
// API docs: https://music.163.com/api/search/get (POST form-urlencoded)
//
// CORS reality check: music.163.com refuses cross-origin browser fetches.
// The authenticated Worker proxy is therefore the primary transport. Direct
// browser requests are retained only as an explicit resilience fallback.
//
// Both paths return the same upstream JSON shape; only the transport differs.

import type { ScrapeResult } from "./types";

const SOURCE = "netease" as const;
const DIRECT_SEARCH = "https://music.163.com/api/search/get";
const DIRECT_LYRIC = "https://music.163.com/api/song/lyric";
const DIRECT_DETAIL = "https://music.163.com/api/song/detail";

interface NetEaseSong {
  id: number;
  name: string;
  artists?: Array<{ name?: string }>;
  album?: {
    name?: string;
    picUrl?: string;
    publishTime?: number;
    artists?: Array<{ name?: string }>;
  };
}

interface NetEaseSearchResp {
  result?: {
    songs?: NetEaseSong[];
  };
}

interface NetEaseDetailResp { songs?: NetEaseSong[] }

interface NetEaseLyricResp {
  lrc?: { lyric?: string };
}

/** Search NetEase by free-text query. Tries direct → proxy. */
export async function search(query: string, proxyFetch: ProxyFn): Promise<ScrapeResult[]> {
  const upstream = await proxyFirst<NetEaseSearchResp>("search", () => proxyFetch({ source: SOURCE, intent: "search", query }), () => directSearch(query));
  return (upstream.result?.songs || []).map((s) => normalise(s));
}

/** Fetch inline lyrics by songId. NetEase returns LRC text. */
export async function fetchLyric(songId: string, proxyFetch: ProxyFn): Promise<string> {
  const upstream = await proxyFirst<NetEaseLyricResp>("lyric", () => proxyFetch({ source: SOURCE, intent: "lyric", songId }), () => directLyric(songId));
  return upstream.lrc?.lyric || "";
}

export async function resolve(result: ScrapeResult, proxyFetch: ProxyFn): Promise<ScrapeResult> {
  const upstream = await proxyFirst<NetEaseDetailResp>("detail", () => proxyFetch({ source: SOURCE, intent: "detail", songId: result.songId }), () => directDetail(result.songId));
  const song = upstream.songs?.[0];
  return song ? { ...result, ...normalise(song), raw: song } : result;
}

// ===========================================================================
// Direct (browser) fetches — likely to fail CORS, but cheap to try.
// ===========================================================================
async function directSearch(query: string): Promise<NetEaseSearchResp> {
  const form = new URLSearchParams({ s: query, type: "1", offset: "0", limit: "20" });
  const resp = await fetch(DIRECT_SEARCH, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function directLyric(songId: string): Promise<NetEaseLyricResp> {
  const url = `${DIRECT_LYRIC}?id=${encodeURIComponent(songId)}&lv=1&kv=1&tv=-1`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function directDetail(songId: string): Promise<NetEaseDetailResp> {
  const url = `${DIRECT_DETAIL}?ids=${encodeURIComponent(`[${songId}]`)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// ===========================================================================
// Normaliser — turns upstream payload into ScrapeResult.
// ===========================================================================
function normalise(s: NetEaseSong): ScrapeResult {
  const year =
    s.album?.publishTime && s.album.publishTime > 0
      ? new Date(s.album.publishTime).getUTCFullYear()
      : undefined;
  return {
    source: SOURCE,
    songId: String(s.id),
    title: s.name || "",
    artist: (s.artists || []).map((a) => a.name).filter(Boolean).join(", ") || "",
    albumArtist: (s.album?.artists || []).map((a) => a.name).filter(Boolean).join(", ") || undefined,
    album: s.album?.name || undefined,
    year,
    coverUrl: s.album?.picUrl || undefined,
    raw: s,
  };
}

// ===========================================================================
// Direct→proxy fallback shared with sibling adapters
// ===========================================================================
export type ProxyFn = (req: {
  source: typeof SOURCE | "lrc" | "qmusic" | "kugou" | "kuwo" | "migu";
  intent: "search" | "lyric" | "detail";
  query?: string;
  songId?: string;
}) => Promise<unknown>;

async function proxyFirst<T>(
  label: string,
  proxyRequest: () => Promise<unknown>,
  directFallback: () => Promise<T>,
): Promise<T> {
  let proxyError = "unknown";
  try {
    const proxied = (await proxyRequest()) as { ok?: boolean; data?: T; error?: string };
    if (proxied?.ok && proxied.data != null) return unwrapNetEase(proxied.data);
    proxyError = proxied?.error || "invalid proxy response";
  } catch (e) { proxyError = e instanceof Error ? e.message : String(e); }
  try { return await directFallback(); } catch (e) {
    throw new Error(`netease ${label}: ${proxyError}; direct fallback: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Accept both the canonical API shape and wrappers emitted by mirrors. */
function unwrapNetEase<T>(value: T): T {
  const candidate = value as NetEaseSearchResp & { data?: unknown; body?: unknown };
  if (!candidate.result && candidate.data && typeof candidate.data === "object") {
    const data = candidate.data as NetEaseSearchResp;
    if (data.result) return data as T;
  }
  if (!candidate.result && candidate.body && typeof candidate.body === "object") {
    const body = candidate.body as NetEaseSearchResp;
    if (body.result) return body as T;
  }
  return value;
}
