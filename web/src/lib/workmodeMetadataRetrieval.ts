// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  isCredibleMetadataMatch,
  isKnownMetadataIdentity,
  normalizeMetadataIdentity,
} from "../../../shared/metadataRetrievalMatch";
import { resolveResult, searchAll } from "./scrape";
import type { ProxyFn, ScrapeResult, ScrapeSource } from "./scrape";

const MAX_COVER_BYTES = 200_000;
const COVER_HOSTS = ["lrc.voidcarve.com", "music.126.net", "y.qq.com"];
const COVER_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

interface RetrievalSnapshot {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  year?: number;
  lyrics?: string;
  coverR2Key?: string | null;
  masterUpdatedAt?: number;
}

export interface MetadataRetrievalPayload {
  kind: "metadata-retrieval";
  masterId: string;
  instanceId: string;
  sourceUri: string;
  sourceEtag?: string | null;
  identity: { title?: string; artist?: string; album?: string };
  snapshot: RetrievalSnapshot;
  sources: string[];
  query: string;
}

export interface MetadataRetrievalResult {
  kind: "metadata-retrieval";
  masterId: string;
  instanceId: string;
  status: "matched" | "no-match";
  reason?: "no-credible-match" | "ambiguous";
  match?: {
    source: ScrapeSource;
    songId: string;
    title: string;
    artist: string;
    album?: string;
    albumArtist?: string;
    year?: number;
    lyrics?: string;
  };
  cover?: { data: string; mime: string };
}

const ALLOWED_SOURCES = new Set<ScrapeSource>(["lrc", "netease", "qmusic", "kugou"]);

export interface MetadataRetrievalAdapters {
  searchAll: typeof searchAll;
  resolveResult: typeof resolveResult;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validSources(value: unknown): ScrapeSource[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((source): source is ScrapeSource =>
    typeof source === "string" && ALLOWED_SOURCES.has(source as ScrapeSource),
  ))];
}

function proxyFor(url: string, signal: AbortSignal, fetcher: typeof fetch): ProxyFn {
  return async (request) => {
    const response = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(request),
      signal,
      credentials: "same-origin",
    });
    const body = await response.json().catch(() => undefined) as
      { ok?: boolean; data?: unknown; error?: string } | undefined;
    if (!response.ok || !body?.ok) {
      throw new Error(body?.error || `scrape proxy failed: HTTP ${response.status}`);
    }
    return body;
  };
}

function candidateKey(result: ScrapeResult): string {
  return [result.title, result.artist, result.album || ""]
    .map(normalizeMetadataIdentity)
    .join("\u001f");
}

function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 6) {
    const signature = String.fromCharCode(...bytes.subarray(0, 6));
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  return undefined;
}

function toMatch(result: ScrapeResult): NonNullable<MetadataRetrievalResult["match"]> {
  return {
    source: result.source,
    songId: result.songId,
    title: result.title,
    artist: result.artist,
    ...(text(result.album) ? { album: text(result.album) } : {}),
    ...(text(result.albumArtist) ? { albumArtist: text(result.albumArtist) } : {}),
    ...(Number.isInteger(result.year) && result.year! >= 1800 && result.year! <= 2200 ? { year: result.year } : {}),
    ...(text(result.lyrics) ? { lyrics: result.lyrics } : {}),
  };
}

function matchesSnapshotConstraints(result: ScrapeResult, snapshot: RetrievalSnapshot): boolean {
  for (const field of ["title", "artist", "album"] as const) {
    const expected = snapshot[field];
    const actual = result[field];
    if (isKnownMetadataIdentity(expected) && (!isKnownMetadataIdentity(actual) ||
        normalizeMetadataIdentity(expected) !== normalizeMetadataIdentity(actual))) return false;
  }
  return true;
}

async function readBoundedImage(url: string, signal: AbortSignal, fetcher: typeof fetch): Promise<MetadataRetrievalResult["cover"]> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== "https:" || !COVER_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) {
    return undefined;
  }

  let response: Response;
  try { response = await fetcher(parsed.toString(), { signal, redirect: "error", credentials: "omit" }); }
  catch { return undefined; }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  const mime = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const declaredSize = Number(response.headers.get("content-length"));
  if (!COVER_MIME_TYPES.has(mime) || (Number.isFinite(declaredSize) && declaredSize > MAX_COVER_BYTES)) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }

  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_COVER_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  if (size === 0) return undefined;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (sniffImageMime(bytes) !== mime) return undefined;
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return { data: btoa(binary), mime };
}

export async function runMetadataRetrieval(
  input: Record<string, unknown>,
  proxyUrl: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  adapters: MetadataRetrievalAdapters = { searchAll, resolveResult },
): Promise<MetadataRetrievalResult> {
  const payload = input as unknown as MetadataRetrievalPayload;
  const masterId = text(payload.masterId);
  const instanceId = text(payload.instanceId);
  const query = text(payload.query);
  if (payload.kind !== "metadata-retrieval" || !masterId || !instanceId || !query || !proxyUrl ||
      !payload.identity || typeof payload.identity !== "object") {
    throw new Error("metadata retrieval task is missing its identity, query, or proxy URL");
  }
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  const sources = validSources(payload.sources);
  if (sources.length === 0) throw new Error("metadata retrieval task has no supported sources");

  const proxyFetch = proxyFor(proxyUrl, signal, fetcher);
  const title = text(payload.identity?.title);
  const artist = text(payload.identity?.artist);
  const album = text(payload.identity?.album);
  const current = {
    ...(title ? { title } : {}),
    ...(artist ? { artist } : {}),
    ...(album ? { album } : {}),
  };
  const searched = await adapters.searchAll({ query, sources, proxyFetch, current, perSourceLimit: 20 });
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  if (searched.errors.length === sources.length) {
    throw new Error(`all metadata sources failed: ${searched.errors.map((error) => `${error.source}: ${error.error}`).join("; ")}`);
  }

  const credible = new Map<string, ScrapeResult>();
  for (const result of searched.results) {
    if (!result.songId || !isCredibleMetadataMatch(result, current) ||
        !matchesSnapshotConstraints(result, payload.snapshot || {})) continue;
    const key = candidateKey(result);
    if (!credible.has(key)) credible.set(key, result);
  }
  if (credible.size === 0) {
    return { kind: "metadata-retrieval", masterId, instanceId, status: "no-match", reason: "no-credible-match" };
  }

  if (credible.size > 1) {
    return { kind: "metadata-retrieval", masterId, instanceId, status: "no-match", reason: "ambiguous" };
  }

  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  const candidate = [...credible.values()][0];
  let match: ScrapeResult;
  try { match = await adapters.resolveResult(candidate, proxyFetch); }
  catch {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    match = candidate;
  }
  if (!isCredibleMetadataMatch(match, current) || !matchesSnapshotConstraints(match, payload.snapshot || {})) {
    return { kind: "metadata-retrieval", masterId, instanceId, status: "no-match", reason: "no-credible-match" };
  }
  const output: MetadataRetrievalResult = {
    kind: "metadata-retrieval",
    masterId,
    instanceId,
    status: "matched",
    match: toMatch(match),
  };
  if (!text(payload.snapshot?.coverR2Key) && match.coverUrl) {
    const cover = await readBoundedImage(match.coverUrl, signal, fetcher);
    if (cover) output.cover = cover;
  }
  return output;
}
