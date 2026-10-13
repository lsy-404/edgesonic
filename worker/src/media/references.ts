// SPDX-License-Identifier: AGPL-3.0-or-later
import { MediaLoaderError, type MediaSession } from "./loader";

export type ExternalProvider = "youtube" | "bilibili";
interface VideoReference { provider: ExternalProvider; url: string; embedUrl: string; title: string }
const hosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com", "youtu.be", "bilibili.com", "www.bilibili.com", "m.bilibili.com", "b23.tv"]);

export async function videoReference(input: string): Promise<VideoReference> {
  if (input.length > 2048) throw new MediaLoaderError("Video link is too long", 400);
  let value = input.trim().replace(/^av\s+(\d+)$/i, "av$1");
  if (/^(BV[0-9A-Za-z]{10}|av\d+)$/i.test(value)) value = `https://www.bilibili.com/video/${value}`;
  else value = value.match(/https?:\/\/[^\s<>"“”]+/i)?.[0]?.replace(/[）)，。！!]+$/, "") || value;
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`); }
  catch { throw new MediaLoaderError("Use a Bilibili or YouTube video link", 400); }
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port || !hosts.has(url.hostname)) throw new MediaLoaderError("Unsupported video link", 400);
    url.protocol = "https:";
    if (url.hostname !== "b23.tv") break;
    if (redirects === 4 || !/^\/[A-Za-z0-9]+\/?$/.test(url.pathname)) throw new MediaLoaderError("Invalid short video link", 400);
    const response = await fetch(url.href, { redirect: "manual", signal: AbortSignal.timeout(8000) });
    await response.body?.cancel();
    const location = response.headers.get("Location");
    if (response.status < 300 || response.status >= 400 || !location) throw new MediaLoaderError("Short video link could not be resolved", 400);
    url = new URL(location, url);
  }
  if (url.hostname.includes("youtube") || url.hostname === "youtu.be") {
    const parts = url.pathname.split("/").filter(Boolean);
    const id = url.hostname === "youtu.be" ? parts[0] : url.searchParams.get("v") || (["embed", "shorts", "live"].includes(parts[0]) ? parts[1] : "");
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new MediaLoaderError("Invalid YouTube video reference", 400);
    return { provider: "youtube", url: `https://www.youtube.com/watch?v=${id}`, embedUrl: `https://www.youtube.com/embed/${id}?autoplay=1`, title: `YouTube · ${id}` };
  }
  const id = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10}|av\d+)(?:\/|$)/i)?.[1];
  const parts = url.searchParams.getAll("p");
  if (!id || parts.length > 1 || (parts.length && !/^[1-9][0-9]{0,4}$/.test(parts[0]))) throw new MediaLoaderError("Invalid Bilibili video reference", 400);
  const part = parts[0] || "1";
  const ref = /^BV/i.test(id) ? `BV${id.slice(2)}` : id.toLowerCase();
  const query = new URLSearchParams({ [/^BV/.test(ref) ? "bvid" : "aid"]: /^BV/.test(ref) ? ref : ref.slice(2), p: part, autoplay: "1" });
  return { provider: "bilibili", url: `https://www.bilibili.com/video/${ref}?p=${part}`, embedUrl: `https://player.bilibili.com/player.html?${query}`, title: `Bilibili · ${ref} · P${part}` };
}

export async function embeddedVideoSession(input: string): Promise<MediaSession> {
  const ref = await videoReference(input);
  return { id: crypto.randomUUID(), transport: "iframe", provider: ref.provider, sourceUrl: ref.embedUrl,
    title: ref.title, duration: null, width: null, height: null, expiresAt: Math.floor(Date.now() / 1000) + 43_200, audioTracks: [], captions: [] };
}
