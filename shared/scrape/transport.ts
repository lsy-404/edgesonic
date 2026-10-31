// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ScrapeSource } from "./types";
interface ProxyBody { query?: string; songId?: string }
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
async function timedJson(url: string, init: RequestInit, label: string, signal?: AbortSignal): Promise<unknown> {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 8000);
  try {
    const response = await fetch(url, { ...init, redirect: "manual", signal: ctrl.signal, headers: { "User-Agent": UA, ...(init.headers || {}) } });
    if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function proxyFetch(
  source: ScrapeSource,
  intent: "search" | "lyric" | "detail",
  body: ProxyBody,
  signal?: AbortSignal,
): Promise<unknown> {
  switch (source) {
    case "lrc":
      return intent === "search" ? fetchLrcAlbums(signal) : fetchLrcAlbumDetail(body.songId!, signal);
    case "netease":
      if (intent === "search") return fetchNetEaseSearch(body.query!, signal);
      return intent === "detail" ? fetchNetEaseDetail(body.songId!, signal) : fetchNetEaseLyric(body.songId!, signal);
    case "qmusic":
      return intent === "search"
        ? fetchQMusicSearch(body.query!, signal)
        : fetchQMusicLyric(body.songId!, signal);
    case "kugou":
      return intent === "search"
        ? fetchKugouSearch(body.query!, signal)
        : fetchKugouLyric(body.songId!, signal);
    case "kuwo":
    case "migu":
      throw new Error(`source ${source} not implemented yet`);
  }
}


// ---- LRC album catalog ----
const LRC_API = "https://lrc.leisiyu.dev/api";

async function fetchLrcAlbums(signal?: AbortSignal): Promise<unknown> {
  return timedJson(`${LRC_API}/albums.json`, { headers: { Accept: "application/json" } }, "lrc albums", signal);
}

async function fetchLrcAlbumDetail(slug: string, signal?: AbortSignal): Promise<unknown> {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(slug)) throw new Error("lrc album slug invalid");
  return timedJson(`${LRC_API}/albums/${encodeURIComponent(slug)}.json`, { headers: { Accept: "application/json" } }, "lrc album detail", signal);
}

// ---- NetEase ----
async function fetchNetEaseSearch(query: string, signal?: AbortSignal): Promise<unknown> {
  // `/api/search/get/web` now returns an encrypted `result` string. The
  // legacy `/api/search/get` endpoint still returns the documented
  // `{ result: { songs } }` payload consumed by the normaliser.
  const url = "https://music.163.com/api/search/get";
  const form = new URLSearchParams({ s: query, type: "1", offset: "0", limit: "20" });
  return timedJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": "https://music.163.com/",
      "User-Agent": UA,
    },
    body: form.toString(),
  }, "netease search", signal);
}

async function fetchNetEaseLyric(songId: string, signal?: AbortSignal): Promise<unknown> {
  if (!/^\d+$/.test(songId)) throw new Error("netease songId must be numeric");
  const url = `https://music.163.com/api/song/lyric?id=${songId}&lv=1&kv=1&tv=-1`;
  return timedJson(url, {
    method: "GET",
    headers: { "Referer": "https://music.163.com/", "User-Agent": UA },
  }, "netease lyric", signal);
}

async function fetchNetEaseDetail(songId: string, signal?: AbortSignal): Promise<unknown> {
  if (!/^\d+$/.test(songId)) throw new Error("netease songId must be numeric");
  const url = `https://music.163.com/api/song/detail?ids=${encodeURIComponent(`[${songId}]`)}`;
  return timedJson(url, {
    method: "GET",
    headers: { "Referer": "https://music.163.com/", "User-Agent": UA },
  }, "netease detail", signal);
}

// ---- QQ Music ----
async function fetchQMusicSearch(query: string, signal?: AbortSignal): Promise<unknown> {
  const url =
    "https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&p=1&n=20&w=" +
    encodeURIComponent(query);
  return timedJson(url, {
    method: "GET",
    headers: { "Referer": "https://y.qq.com/", "User-Agent": UA },
  }, "qmusic search", signal);
}

async function fetchQMusicLyric(songmid: string, signal?: AbortSignal): Promise<unknown> {
  if (!/^[A-Za-z0-9]{6,}$/.test(songmid)) throw new Error("qmusic songmid invalid");
  const url =
    "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=" +
    songmid + "&format=json&nobase64=1";
  return timedJson(url, {
    method: "GET",
    headers: { "Referer": "https://y.qq.com/", "User-Agent": UA },
  }, "qmusic lyric", signal);
}

// ---- Kugou ----
async function fetchKugouSearch(query: string, signal?: AbortSignal): Promise<unknown> {
  const url =
    "https://songsearch.kugou.com/song_search_v2?keyword=" +
    encodeURIComponent(query) + "&page=1&pagesize=20";
  return timedJson(url, {
    method: "GET",
    headers: { "Referer": "https://www.kugou.com/", "User-Agent": UA },
  }, "kugou search", signal);
}

async function fetchKugouLyric(hash: string, signal?: AbortSignal): Promise<unknown> {
  // hash is FileHash (32 hex chars). Two-step lookup: search → download.
  if (!/^[A-F0-9]{32}$/i.test(hash)) throw new Error("kugou hash invalid");
  const searchUrl =
    "https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&hash=" + hash;
  const searchJson = await timedJson(searchUrl, {
    method: "GET",
    headers: { "User-Agent": UA },
  }, "kugou krc search", signal) as { candidates?: Array<{ id: string; accesskey: string }> };
  const cand = (searchJson.candidates || [])[0];
  if (!cand) throw new Error("kugou krc no candidate");

  const dlUrl =
    "https://lyrics.kugou.com/download?ver=1&client=pc&id=" + encodeURIComponent(cand.id) +
    "&accesskey=" + encodeURIComponent(cand.accesskey) + "&fmt=lrc&charset=utf8";
  return timedJson(dlUrl, {
    method: "GET",
    headers: { "User-Agent": UA },
  }, "kugou lyric", signal);
}
