// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ScrapeSource } from "./types";
interface ProxyBody { query?: string; songId?: string }
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
async function timedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try { return await fetch(url, { ...init, signal: ctrl.signal, headers: { "User-Agent": UA, ...(init.headers || {}) } }); }
  finally { clearTimeout(timer); }
}

export async function proxyFetch(
  source: ScrapeSource,
  intent: "search" | "lyric" | "detail",
  body: ProxyBody,
): Promise<unknown> {
  switch (source) {
    case "lrc":
      return intent === "search" ? fetchLrcAlbums() : fetchLrcAlbumDetail(body.songId!);
    case "netease":
      if (intent === "search") return fetchNetEaseSearch(body.query!);
      return intent === "detail" ? fetchNetEaseDetail(body.songId!) : fetchNetEaseLyric(body.songId!);
    case "qmusic":
      return intent === "search"
        ? fetchQMusicSearch(body.query!)
        : fetchQMusicLyric(body.songId!);
    case "kugou":
      return intent === "search"
        ? fetchKugouSearch(body.query!)
        : fetchKugouLyric(body.songId!);
    case "kuwo":
    case "migu":
      throw new Error(`source ${source} not implemented yet`);
  }
}

// timedFetch / UA come from utils/scrapeFetch.ts (shared with artistScrape).

// ---- LRC album catalog ----
const LRC_API = "https://lrc.leisiyu.dev/api";

async function fetchLrcAlbums(): Promise<unknown> {
  const resp = await timedFetch(`${LRC_API}/albums.json`, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`lrc albums HTTP ${resp.status}`);
  return await resp.json();
}

async function fetchLrcAlbumDetail(slug: string): Promise<unknown> {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(slug)) throw new Error("lrc album slug invalid");
  const resp = await timedFetch(`${LRC_API}/albums/${encodeURIComponent(slug)}.json`, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`lrc album detail HTTP ${resp.status}`);
  return await resp.json();
}

// ---- NetEase ----
async function fetchNetEaseSearch(query: string): Promise<unknown> {
  // `/api/search/get/web` now returns an encrypted `result` string. The
  // legacy `/api/search/get` endpoint still returns the documented
  // `{ result: { songs } }` payload consumed by the normaliser.
  const url = "https://music.163.com/api/search/get";
  const form = new URLSearchParams({ s: query, type: "1", offset: "0", limit: "20" });
  const resp = await timedFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": "https://music.163.com/",
      "User-Agent": UA,
    },
    body: form.toString(),
  });
  if (!resp.ok) throw new Error(`netease search HTTP ${resp.status}`);
  return await resp.json();
}

async function fetchNetEaseLyric(songId: string): Promise<unknown> {
  if (!/^\d+$/.test(songId)) throw new Error("netease songId must be numeric");
  const url = `https://music.163.com/api/song/lyric?id=${songId}&lv=1&kv=1&tv=-1`;
  const resp = await timedFetch(url, {
    method: "GET",
    headers: { "Referer": "https://music.163.com/", "User-Agent": UA },
  });
  if (!resp.ok) throw new Error(`netease lyric HTTP ${resp.status}`);
  return await resp.json();
}

async function fetchNetEaseDetail(songId: string): Promise<unknown> {
  if (!/^\d+$/.test(songId)) throw new Error("netease songId must be numeric");
  const url = `https://music.163.com/api/song/detail?ids=${encodeURIComponent(`[${songId}]`)}`;
  const resp = await timedFetch(url, {
    method: "GET",
    headers: { "Referer": "https://music.163.com/", "User-Agent": UA },
  });
  if (!resp.ok) throw new Error(`netease detail HTTP ${resp.status}`);
  return await resp.json();
}

// ---- QQ Music ----
async function fetchQMusicSearch(query: string): Promise<unknown> {
  const url =
    "https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&p=1&n=20&w=" +
    encodeURIComponent(query);
  const resp = await timedFetch(url, {
    method: "GET",
    headers: { "Referer": "https://y.qq.com/", "User-Agent": UA },
  });
  if (!resp.ok) throw new Error(`qmusic search HTTP ${resp.status}`);
  return await resp.json();
}

async function fetchQMusicLyric(songmid: string): Promise<unknown> {
  if (!/^[A-Za-z0-9]{6,}$/.test(songmid)) throw new Error("qmusic songmid invalid");
  const url =
    "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=" +
    songmid + "&format=json&nobase64=1";
  const resp = await timedFetch(url, {
    method: "GET",
    headers: { "Referer": "https://y.qq.com/", "User-Agent": UA },
  });
  if (!resp.ok) throw new Error(`qmusic lyric HTTP ${resp.status}`);
  return await resp.json();
}

// ---- Kugou ----
async function fetchKugouSearch(query: string): Promise<unknown> {
  const url =
    "https://songsearch.kugou.com/song_search_v2?keyword=" +
    encodeURIComponent(query) + "&page=1&pagesize=20";
  const resp = await timedFetch(url, {
    method: "GET",
    headers: { "Referer": "https://www.kugou.com/", "User-Agent": UA },
  });
  if (!resp.ok) throw new Error(`kugou search HTTP ${resp.status}`);
  return await resp.json();
}

async function fetchKugouLyric(hash: string): Promise<unknown> {
  // hash is FileHash (32 hex chars). Two-step lookup: search → download.
  if (!/^[A-F0-9]{32}$/i.test(hash)) throw new Error("kugou hash invalid");
  const searchUrl =
    "https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&hash=" + hash;
  const searchResp = await timedFetch(searchUrl, {
    method: "GET",
    headers: { "User-Agent": UA },
  });
  if (!searchResp.ok) throw new Error(`kugou krc search HTTP ${searchResp.status}`);
  const searchJson = (await searchResp.json()) as { candidates?: Array<{ id: string; accesskey: string }> };
  const cand = (searchJson.candidates || [])[0];
  if (!cand) throw new Error("kugou krc no candidate");

  const dlUrl =
    "https://lyrics.kugou.com/download?ver=1&client=pc&id=" + cand.id +
    "&accesskey=" + cand.accesskey + "&fmt=lrc&charset=utf8";
  const dlResp = await timedFetch(dlUrl, {
    method: "GET",
    headers: { "User-Agent": UA },
  });
  if (!dlResp.ok) throw new Error(`kugou lyric HTTP ${dlResp.status}`);
  return await dlResp.json();
}
