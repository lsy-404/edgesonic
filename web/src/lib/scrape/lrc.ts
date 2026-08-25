// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ScrapeResult } from "./types";
import type { ProxyFn } from "./netease";

const SOURCE = "lrc" as const;
const API = "https://lrc.wuyilingwei.com/api";

interface LrcSong {
  title?: string;
  file?: string;
  lyrics?: Array<{ time?: number; text?: string }>;
}

interface LrcAlbum {
  slug?: string;
  name?: string;
  zh_name?: string;
  en_name?: string;
  year?: string;
  produce?: string[];
  vocal?: string[];
  composer?: string[];
  lyricist?: string[];
  cover?: string | null;
  songs?: LrcSong[];
}

interface LrcAlbumsResponse {
  albums?: LrcAlbum[];
}

function names(values: unknown): string {
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(", ") : "";
}

function year(value: unknown): number | undefined {
  const match = /^(\d{4})/.exec(typeof value === "string" ? value : "");
  return match ? Number(match[1]) : undefined;
}

function coverUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/albums/")) return undefined;
  return new URL(value, "https://lrc.wuyilingwei.com").toString();
}

function searchText(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, "");
}

function matches(album: LrcAlbum, song: LrcSong, query: string): boolean {
  const haystack = searchText([
    album.name, album.zh_name, album.en_name, names(album.produce), names(album.vocal), song.title,
  ].filter(Boolean).join(" "));
  const tokens = query.split(/\s+/).map(searchText).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

async function fetchJson<T>(url: string, proxyFetch: ProxyFn, intent: "search" | "detail", songId?: string): Promise<T> {
  let proxyError = "unknown";
  try {
    const proxied = await proxyFetch({ source: SOURCE, intent, ...(songId ? { songId } : {}) }) as { ok?: boolean; data?: T; error?: string };
    if (proxied?.ok && proxied.data != null) return proxied.data;
    proxyError = proxied?.error || "invalid proxy response";
  } catch (error) { proxyError = error instanceof Error ? error.message : String(error); }
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as T;
  } catch (error) { throw new Error(`lrc ${intent}: ${proxyError}; direct fallback: ${error instanceof Error ? error.message : String(error)}`); }
}

export async function search(query: string, proxyFetch: ProxyFn): Promise<ScrapeResult[]> {
  const data = await fetchJson<LrcAlbumsResponse>(`${API}/albums.json`, proxyFetch, "search");
  const rows: ScrapeResult[] = [];
  for (const album of data.albums || []) {
    if (!album.slug) continue;
    for (const song of album.songs || []) {
      if (!song.title || !matches(album, song, query)) continue;
      rows.push({
        source: SOURCE,
        songId: album.slug,
        title: song.title,
        artist: names(album.vocal) || names(album.produce),
        albumArtist: names(album.produce) || names(album.vocal) || undefined,
        album: album.name || album.zh_name || album.en_name || undefined,
        year: year(album.year),
        coverUrl: coverUrl(album.cover),
        raw: { slug: album.slug, songTitle: song.title },
      });
    }
  }
  return rows;
}

function lyricsToLrc(lines: LrcSong["lyrics"]): string | undefined {
  if (!Array.isArray(lines)) return undefined;
  const output = lines.flatMap((line) => {
    if (typeof line.text !== "string" || !Number.isFinite(line.time)) return [];
    const centiseconds = Math.max(0, Math.round((line.time as number) * 100));
    const minutes = Math.floor(centiseconds / 6000);
    const seconds = Math.floor((centiseconds % 6000) / 100);
    const fraction = centiseconds % 100;
    return [`[${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(2, "0")}]${line.text}`];
  });
  return output.length > 0 ? output.join("\n") : undefined;
}

export async function resolve(result: ScrapeResult, proxyFetch: ProxyFn): Promise<ScrapeResult> {
  const raw = result.raw as { slug?: string; songTitle?: string } | undefined;
  if (!raw?.slug || !raw.songTitle) return result;
  const detail = await fetchJson<LrcAlbum>(`${API}/albums/${encodeURIComponent(raw.slug)}.json`, proxyFetch, "detail", raw.slug);
  const song = (detail.songs || []).find((candidate) => candidate.title === raw.songTitle);
  return {
    ...result,
    artist: names(detail.vocal) || names(detail.produce) || result.artist,
    albumArtist: names(detail.produce) || names(detail.vocal) || result.albumArtist,
    album: detail.name || detail.zh_name || detail.en_name || result.album,
    year: year(detail.year) || result.year,
    coverUrl: coverUrl(detail.cover) || result.coverUrl,
    lyrics: lyricsToLrc(song?.lyrics),
    raw: {
      slug: raw.slug,
      songTitle: raw.songTitle,
      producers: detail.produce || [],
      vocal: detail.vocal || [],
      lyricists: detail.lyricist || [],
      composers: detail.composer || [],
    },
  };
}

export async function fetchLyric(): Promise<string> {
  return "";
}
