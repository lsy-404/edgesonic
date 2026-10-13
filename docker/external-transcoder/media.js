import express from "express";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const ROOT = path.join(os.tmpdir(), "edgesonic-media");
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 12;
const MAX_ACTIVE_JOBS = 3;
const MAX_ACTIVE_UPLOADS = 2;
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const MAX_SESSION_DISK_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_DANMAKU_BYTES = 4 * 1024 * 1024;
const MAX_SUBTITLE_BYTES = 16 * 1024 * 1024;
const ID_PATTERN = /^[a-f0-9]{48}$/;
const VIDEO_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.bilibili.com", "bilibili.com", "www.bilibili.tv", "bilibili.tv"]);
const BILI_HOSTS = new Set(["b23.tv", "www.b23.tv", "bilibili.com", "www.bilibili.com", "bilibili.tv", "www.bilibili.tv"]);
const EXTERNAL_MEDIA_HOSTS = ["youtube.com", "googlevideo.com", "googleusercontent.com", "bilibili.com", "bilivideo.com", "bilivideo.cn", "biliapi.net", "hdslb.com"];
const sessions = new Map();
const activeJobs = new Set();
let activeResolvers = 0;
let activeUploads = 0;

await mkdir(ROOT, { recursive: true });
for (const entry of await readdir(ROOT, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name.startsWith("session-")) await rm(path.join(ROOT, entry.name), { recursive: true, force: true });
}

function publicError(res, status, message) {
  return res.status(status).json({ error: message });
}

function allowedHost(host, hosts) {
  return hosts.has(host.toLowerCase());
}

function validExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (EXTERNAL_MEDIA_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)) || (/^upos-[a-z0-9-]+\.akamaized\.net$/i.test(url.hostname)));
  } catch {
    return false;
  }
}

function validDanmakuUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["bilibili.com", "bilibili.tv", "hdslb.com"].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

async function resolveShortUrl(value) {
  let current = new URL(value);
  for (let i = 0; i < 6; i += 1) {
    if (!allowedHost(current.hostname, BILI_HOSTS)) throw new Error("unsupported URL");
    const response = await fetch(current, { method: "GET", redirect: "manual", headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(8000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("invalid redirect");
      current = new URL(location, current);
      continue;
    }
    await response.body?.cancel();
    return current;
  }
  throw new Error("too many redirects");
}

async function normalizeSource(value) {
  const bv = /^BV[0-9A-Za-z]{10}$/.test(value) ? value : null;
  const av = /^av[0-9]{1,20}$/i.test(value) ? value : null;
  if (bv || av) return `https://www.bilibili.com/video/${bv || av}/`;
  let url;
  try { url = new URL(value); } catch { throw new Error("invalid URL"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("unsupported URL");
  if (allowedHost(url.hostname, new Set(["b23.tv", "www.b23.tv"]))) url = await resolveShortUrl(url.href);
  if (!allowedHost(url.hostname, VIDEO_HOSTS)) throw new Error("unsupported URL");
  if (url.hostname.endsWith("youtube.com") && !["/watch", "/shorts/", "/embed/", "/live/"].some((part) => url.pathname.startsWith(part))) throw new Error("unsupported URL");
  if (url.searchParams.has("list") || url.pathname.startsWith("/playlist/")) throw new Error("unsupported URL");
  if (url.hostname === "youtu.be" && url.pathname.length < 2) throw new Error("unsupported URL");
  if (!url.hostname.includes("youtube") && !url.hostname.includes("youtu.be") && !/^\/(video\/)?(BV[0-9A-Za-z]{10}|av[0-9]{1,20})/.test(url.pathname)) throw new Error("unsupported URL");
  return url.href;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { maxOutput = 32 * 1024 * 1024, timeoutMs = 120000, onChild, ...spawnOptions } = options;
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...spawnOptions });
    onChild?.(child);
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs).unref();
    child.stderr.resume();
    let stdout = Buffer.alloc(0);
    let overflow = false;
    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length > maxOutput) { overflow = true; child.kill("SIGKILL"); return; }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.on("error", () => { clearTimeout(timeout); reject(new Error("media tool unavailable")); });
    child.on("close", (code) => { clearTimeout(timeout); code === 0 && !overflow ? resolve(stdout) : reject(new Error("media processing failed")); });
  });
}

function runJson(command, args) {
  return run(command, args, { maxOutput: 32 * 1024 * 1024 }).then((bytes) => JSON.parse(bytes.toString("utf8")));
}

function ffprobe(file) {
  return runJson("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]);
}

function sessionShape(session) {
  return {
    id: session.id,
    title: session.title,
    duration: session.duration,
    width: session.width,
    height: session.height,
    expiresAt: Math.floor(session.expiresAt / 1000),
    audioTracks: session.audioTracks.map(({ id, language, title }) => ({ id, ...(language ? { language } : {}), ...(title ? { title } : {}) })),
    captions: session.captions.map(({ id, language, title }) => ({ id, ...(language ? { language } : {}), ...(title ? { title } : {}) })),
  };
}

function createRecord(data) {
  const id = randomBytes(24).toString("hex");
  const session = { ...data, id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS, jobs: new Set(), generatingVariants: new Set(), timer: null };
  session.timer = setTimeout(() => removeSession(session), SESSION_TTL_MS).unref();
  sessions.set(id, session);
  return session;
}

async function removeSession(session) {
  if (!session) return;
  clearTimeout(session.timer);
  sessions.delete(session.id);
  for (const job of session.jobs) {
    job.child?.kill("SIGKILL");
    job.controller.abort();
  }
  await rm(session.dir, { recursive: true, force: true }).catch(() => {});
}

function getSession(req, res) {
  if (!ID_PATTERN.test(req.params.id)) { publicError(res, 404, "session not found"); return null; }
  const session = sessions.get(req.params.id);
  if (!session || session.expiresAt <= Date.now()) { if (session) void removeSession(session); publicError(res, 404, "session not found"); return null; }
  return session;
}

function acquireJob(session, res) {
  if (activeJobs.size >= MAX_ACTIVE_JOBS) { publicError(res, 429, "media workers busy"); return null; }
  const job = { child: null, controller: new AbortController() };
  activeJobs.add(job);
  session.jobs.add(job);
  return job;
}

function finishJob(session, job) {
  session.jobs.delete(job);
  activeJobs.delete(job);
}

function numeric(value, min, max) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : NaN;
}

function dimensions(value) {
  if (!value) return null;
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(value);
  if (!match) return NaN;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width >= 144 && width <= 7680 && height >= 144 && height <= 4320 ? { width, height } : NaN;
}

function fitDimensions(width, height, bounds) {
  if (!width || !height || !bounds) return bounds;
  const scale = Math.min(bounds.width / width, bounds.height / height);
  return { width: Math.max(2, Math.floor((width * scale) / 2) * 2), height: Math.max(2, Math.floor((height * scale) / 2) * 2) };
}

function audioIndex(session, track) {
  if (track == null) return null;
  const id = String(track);
  return session.audioTracks.find((item) => item.id === id) || null;
}

function selectedSource(session, audioId) {
  if (session.kind === "native") return { native: true, audio: session.audioTracks.find((track) => track.id === audioId) || session.audioTracks[0] };
  const audio = session.sources.audioTracks.find((track) => track.id === audioId) || session.sources.audioTracks[0];
  const video = session.sources.video;
  if (!video || !audio) throw new Error("media source unavailable");
  return { video, audio };
}

function addHeaderArgs(args, headers) {
  if (!headers || typeof headers !== "object") return;
  const safe = Object.entries(headers).filter(([key, value]) => /^[A-Za-z0-9-]+$/.test(key) && typeof value === "string" && !/[\r\n]/.test(value));
  if (safe.length) args.push("-headers", safe.map(([key, value]) => `${key}: ${value}`).join("\r\n") + "\r\n");
}

function ffmpegInputs(session, selected) {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  if (selected.video) { addHeaderArgs(args, selected.video.headers); args.push("-i", selected.video.url); addHeaderArgs(args, selected.audio.headers); args.push("-i", selected.audio.url); }
  else args.push("-i", session.file);
  return args;
}

function ffmpegAudioInputs(session, selected) {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  if (selected.video) { addHeaderArgs(args, selected.audio.headers); args.push("-i", selected.audio.url); }
  else args.push("-i", session.file);
  return args;
}

function sourceMaps(selected, session) {
  if (selected.video) return ["-map", "0:v:0", "-map", "1:a:0"];
  const audio = selected.audio || session.audioTracks[0];
  return ["-map", "0:v:0", "-map", audio ? `0:${audio.id}` : "0:a:0?"];
}

function ffmpegForStream(session, options, job) {
  const selected = selectedSource(session, options.audioTrack);
  const args = [...(options.format ? ffmpegAudioInputs(session, selected) : ffmpegInputs(session, selected))];
  if (options.format) {
    args.push("-map", selected.video ? "0:a:0" : `0:${selected.audio?.id || "a:0"}`, "-vn", "-sn", "-dn", "-c:a", options.format === "mp3" ? "libmp3lame" : options.format === "opus" ? "libopus" : "aac");
    if (options.bitRate) args.push("-b:a", `${options.bitRate}k`);
    if (options.timeOffset != null) args.push("-ss", String(options.timeOffset));
    if (options.format === "m4a") args.push("-movflags", "frag_keyframe+empty_moov+default_base_moof");
    args.push("-f", options.format === "mp3" ? "mp3" : options.format === "opus" ? "opus" : "ipod", "pipe:1");
    return spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  }
  args.push(...sourceMaps(selected, session));
  if (options.timeOffset != null) args.push("-ss", String(options.timeOffset));
  if (options.size) args.push("-vf", `scale=${options.size.width}:${options.size.height}:force_original_aspect_ratio=decrease`);
  if (options.bitRate) args.push("-b:v", `${options.bitRate}k`, "-maxrate", `${options.bitRate}k`, "-bufsize", `${options.bitRate * 2}k`);
  args.push("-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1");
  return spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
}

function probeTracks(probe) {
  const streams = probe.streams || [];
  const audioTracks = streams.filter((s) => s.codec_type === "audio").map((s, i) => ({ id: String(s.index), ...(s.tags?.language ? { language: s.tags.language } : {}), ...(s.tags?.title ? { title: s.tags.title } : { title: `Audio ${i + 1}` }) }));
  const captions = streams.filter((s) => s.codec_type === "subtitle").map((s, i) => ({ id: String(s.index), streamIndex: s.index, ...(s.tags?.language ? { language: s.tags.language } : {}), ...(s.tags?.title ? { title: s.tags.title } : { title: `Subtitle ${i + 1}` }) }));
  const video = streams.find((s) => s.codec_type === "video");
  return { duration: Number.isFinite(Number(probe.format?.duration)) ? Number(probe.format.duration) : null, width: video?.width || null, height: video?.height || null, audioTracks, captions };
}

function mapSubtitleTracks(info) {
  const tracks = [];
  for (const [language, entries] of Object.entries(info.subtitles || {})) {
    if (language.toLowerCase() === "danmaku") continue;
    for (const entry of entries) {
      if (!validExternalUrl(entry.url)) continue;
      tracks.push({ id: `sub-${tracks.length}`, language, title: entry.name || entry.ext || language, ext: entry.ext, url: entry.url, headers: info.http_headers || {} });
    }
  }
  return tracks;
}

function mapAudioFormats(info) {
  const formats = (info.formats || []).filter((format) => format.url && validExternalUrl(format.url));
  const audioFormats = formats.filter((f) => f.acodec && f.acodec !== "none");
  const groups = new Map();
  for (const format of audioFormats) {
    const language = format.language || "und";
    const list = groups.get(language) || [];
    list.push(format);
    groups.set(language, list);
  }
  const audioTracks = [...groups.entries()].map(([language, list]) => {
    list.sort((a, b) => Number(b.vcodec === "none") - Number(a.vcodec === "none") || (b.audio_channels || 0) - (a.audio_channels || 0) || (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));
    const format = list[0];
    return { id: `audio-${language}`, ...(language !== "und" ? { language } : {}), title: language === "und" ? (format.format_note || "Original audio") : language, url: format.url, headers: format.http_headers || info.http_headers || {} };
  });
  const video = formats.filter((f) => f.vcodec && f.vcodec !== "none").sort((a, b) => Number(b.acodec === "none") - Number(a.acodec === "none") || (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0))[0];
  return { video: video && { url: video.url, headers: video.http_headers || info.http_headers || {} }, audioTracks };
}

function safeCaptionTrack(track) {
  return { id: track.id, ...(track.language ? { language: track.language } : {}), ...(track.title ? { title: track.title } : {}) };
}

async function fetchLimited(url, headers, maximum, signal) {
  if (!validExternalUrl(url)) throw new Error("invalid media resource");
  const response = await fetch(url, { redirect: "manual", headers: headers || {}, signal: signal || AbortSignal.timeout(20000) });
  if (response.status < 200 || response.status >= 300) throw new Error("media resource unavailable");
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximum) { await response.body?.cancel(); throw new Error("media resource too large"); }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) { await response.body.cancel(); throw new Error("media resource too large"); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function handleResolve(req, res) {
  if (sessions.size + activeResolvers + activeUploads >= MAX_SESSIONS) return publicError(res, 429, "too many media sessions");
  if (!req.body || typeof req.body.url !== "string" || req.body.url.length > 2048) return publicError(res, 400, "invalid request");
  if (activeResolvers >= 2) return publicError(res, 429, "media resolver busy");
  activeResolvers += 1;
  try {
    if (sessions.size + activeResolvers + activeUploads > MAX_SESSIONS) return publicError(res, 429, "too many media sessions");
    let source;
    try { source = await normalizeSource(req.body.url.trim()); } catch { return publicError(res, 400, "unsupported media URL"); }
    const info = await runJson("yt-dlp", ["--no-warnings", "--no-playlist", "--skip-download", "--no-progress", "--js-runtimes", "node", "--dump-single-json", source]);
    if (!info || info._type === "playlist" || info.entries || info.is_live || ["is_live", "is_upcoming"].includes(info.live_status) || !info.title) return publicError(res, 400, "unsupported media");
    const sources = mapAudioFormats(info);
    if (!sources.video || !sources.audioTracks.length) return publicError(res, 422, "video stream unavailable");
    await mkdir(ROOT, { recursive: true });
    const dir = await mkdtemp(path.join(ROOT, "session-"));
    const danmaku = (info.subtitles?.danmaku || []).find((entry) => validDanmakuUrl(entry.url));
    const captions = mapSubtitleTracks(info);
    const session = createRecord({ kind: "remote", dir, title: String(info.title).slice(0, 500), duration: Number.isFinite(info.duration) ? info.duration : null, width: info.width || sources.video.width || null, height: info.height || sources.video.height || null, sources, sourceCaptions: captions, captions: captions.map(safeCaptionTrack), danmaku: danmaku ? { url: danmaku.url, headers: info.http_headers || {} } : null, audioTracks: sources.audioTracks.map(({ url, headers, ...item }) => item) });
    return res.status(201).json(sessionShape(session));
  } catch {
    return publicError(res, 422, "unable to resolve media");
  } finally {
    activeResolvers -= 1;
  }
}

async function handleUpload(req, res) {
  if (activeUploads >= MAX_ACTIVE_UPLOADS) return publicError(res, 429, "upload workers busy");
  if (sessions.size + activeResolvers + activeUploads >= MAX_SESSIONS) return publicError(res, 429, "too many media sessions");
  const type = String(req.get("Content-Type") || "").toLowerCase();
  if (!/^video\/(mp4|webm|quicktime|x-matroska|ogg)$/.test(type) && type !== "application/octet-stream") return publicError(res, 415, "unsupported video type");
  const length = Number(req.get("Content-Length"));
  if (Number.isFinite(length) && length > MAX_UPLOAD_BYTES) return publicError(res, 413, "video too large");
  const suffix = String(req.query.suffix || "").toLowerCase();
  if (suffix && ![".mp4", ".m4v", ".mov", ".webm", ".mkv", ".ogv"].includes(suffix)) return publicError(res, 400, "invalid suffix");
  activeUploads += 1;
  let dir;
  let written = 0;
  try {
    await mkdir(ROOT, { recursive: true });
    dir = await mkdtemp(path.join(ROOT, "session-"));
    const file = path.join(dir, `source${suffix}`);
    const output = createWriteStream(file, { flags: "wx" });
    req.on("data", (chunk) => { written += chunk.length; if (written > MAX_UPLOAD_BYTES) req.destroy(new Error("upload too large")); });
    await pipeline(req, output);
    const probe = await ffprobe(file);
    if (!probe.streams?.some((stream) => stream.codec_type === "video")) throw new Error("video stream missing");
    const tracks = probeTracks(probe);
    const session = createRecord({ kind: "native", dir, file, title: String(req.query.title || path.basename(file)).slice(0, 500), ...tracks });
    return res.status(201).json(sessionShape(session));
  } catch {
    if (dir) await rm(dir, { recursive: true, force: true });
    if (!res.headersSent) publicError(res, written > MAX_UPLOAD_BYTES ? 413 : 400, written > MAX_UPLOAD_BYTES ? "video too large" : "invalid video");
  } finally {
    activeUploads -= 1;
  }
}

function validatePlaybackOptions(req, session, res) {
  const timeOffset = numeric(req.query.timeOffset, 0, Math.min(session.duration || 86400, 86400));
  const bitRate = numeric(req.query.bitRate, 64, 50000);
  const size = dimensions(req.query.size);
  if ([timeOffset, bitRate].some(Number.isNaN) || (req.query.size && Number.isNaN(size))) { publicError(res, 400, "invalid playback options"); return null; }
  const track = audioIndex(session, req.query.audioTrack);
  if (req.query.audioTrack != null && !track) { publicError(res, 400, "unknown audio track"); return null; }
  const format = req.query.format == null ? null : String(req.query.format).toLowerCase();
  if (format && !["mp3", "m4a", "opus"].includes(format)) { publicError(res, 400, "unsupported output format"); return null; }
  if (format && session.audioTracks.length === 0) { publicError(res, 422, "audio track unavailable"); return null; }
  return { timeOffset, bitRate, size, audioTrack: track?.id, format };
}

function terminateOnClose(req, res, session, job) {
  let finished = false;
  const done = () => { if (!finished) { finished = true; finishJob(session, job); } };
  const close = () => { if (!res.writableEnded && job.child && !job.child.killed) job.child.kill("SIGKILL"); done(); };
  req.once("aborted", close);
  res.once("close", close);
  return done;
}

function cancelOnDisconnect(req, res, job) {
  const cancel = () => job.controller.abort();
  req.once("aborted", cancel);
  res.once("close", () => { if (!res.writableEnded) cancel(); });
}

function streamMedia(req, res, session, options) {
  const job = acquireJob(session, res);
  if (!job) return;
  cancelOnDisconnect(req, res, job);
  try {
    const ff = ffmpegForStream(session, options, job);
    job.child = ff;
    const done = terminateOnClose(req, res, session, job);
    const contentType = options.format === "mp3" ? "audio/mpeg" : options.format === "opus" ? "audio/opus" : options.format === "m4a" ? "audio/mp4" : "video/mp4";
    res.status(200).set({ "Content-Type": contentType, "Cache-Control": "no-store", "Transfer-Encoding": "chunked" });
    ff.stdout.pipe(res);
    ff.stderr.resume();
    ff.once("error", () => { if (!res.headersSent) publicError(res, 502, "media processing failed"); done(); });
    ff.once("close", (code) => { if (code !== 0 && !res.writableEnded) res.end(); done(); });
  } catch {
    finishJob(session, job);
    publicError(res, 422, "media processing failed");
  }
}

function sendNativeRange(req, res, session) {
  const fileName = path.basename(session.file);
  res.type("video/mp4").set("Cache-Control", "no-store").sendFile(fileName, { root: session.dir }, (error) => { if (error && !res.headersSent) publicError(res, 404, "media file unavailable"); });
}

function hlsArguments(session, variant, options, outDir) {
  const selected = selectedSource(session, options.audioTrack);
  const args = [...(options.audioOnly ? ffmpegAudioInputs(session, selected) : ffmpegInputs(session, selected))];
  if (options.audioOnly) {
    args.push("-map", selected.video ? "0:a:0" : `0:${selected.audio?.id || "a:0"}`, "-vn", "-sn", "-dn", "-c:a", "aac", "-b:a", `${variant.rate}k`);
  } else {
    args.push(...sourceMaps(selected, session));
    if (options.size) args.push("-vf", `scale=${options.size.width}:${options.size.height}:force_original_aspect_ratio=decrease`);
    args.push("-c:v", "libx264", "-preset", "veryfast", "-b:v", `${variant.rate}k`, "-maxrate", `${variant.rate}k`, "-bufsize", `${variant.rate * 2}k`, "-c:a", "aac", "-b:a", "128k");
  }
  args.push("-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod", "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", path.join(outDir, "seg-%05d.m4s"), path.join(outDir, "index.m3u8"));
  return args;
}

function validateVariants(values, session, res) {
  const raw = values.length ? values : ["1200"];
  if (raw.length > 5) { publicError(res, 400, "too many variants"); return null; }
  const variants = [];
  for (const value of raw) {
    const match = /^(\d{2,5})(?:@(\d{2,5}x\d{2,5}))?$/.exec(value);
    if (!match) { publicError(res, 400, "invalid HLS variant"); return null; }
    const rate = Number(match[1]);
    const size = dimensions(match[2]);
    if (rate < 64 || rate > 50000 || (match[2] && Number.isNaN(size))) { publicError(res, 400, "invalid HLS variant"); return null; }
    const target = size || (session.width && session.height ? { width: session.width, height: session.height } : null);
    const outputSize = fitDimensions(session.width, session.height, target);
    const variant = { rate, size: outputSize };
    variant.key = `${variant.rate}-${variant.size?.width || 0}x${variant.size?.height || 0}`;
    if (variants.some((item) => item.key === variant.key)) { publicError(res, 400, "duplicate HLS variant"); return null; }
    variants.push(variant);
  }
  return variants;
}

async function waitForPlaylist(file, child, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await directorySize(path.dirname(path.dirname(file))) > MAX_SESSION_DISK_BYTES) { child.kill("SIGKILL"); throw new Error("session disk limit exceeded"); } } catch (error) { if (error.message === "session disk limit exceeded") throw error; }
    try { if ((await stat(file)).size > 0) return; } catch {}
    if (child.exitCode != null) throw new Error("hls generation failed");
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  child.kill("SIGKILL");
  throw new Error("hls generation timeout");
}

async function directorySize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(file);
    else total += (await stat(file)).size;
    if (total > MAX_SESSION_DISK_BYTES) return total;
  }
  return total;
}

function masterPlaylist(variants, metadata, audioTrack, audioOnly) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7"];
  for (const variant of variants) {
    const size = variant.size || (metadata.width && metadata.height ? { width: metadata.width, height: metadata.height } : null);
    const bandwidth = variant.rate * 1000 + (audioOnly ? 0 : 128000);
    const resolution = !audioOnly && size ? `,RESOLUTION=${size.width}x${size.height}` : "";
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${bandwidth}${resolution}`);
    lines.push(`file/${variant.key}/index.m3u8`);
  }
  return lines.join("\n") + "\n";
}

async function serveHls(req, res, session, options) {
  const variants = validateVariants([].concat(req.query.bitRate || []), session, res);
  if (!variants) return;
  const job = acquireJob(session, res);
  if (!job) return;
  const done = terminateOnClose(req, res, session, job);
  if (variants.some((variant) => session.generatingVariants.has(variant.key))) {
    done();
    return publicError(res, 409, "HLS variant is already generating");
  }
  for (const variant of variants) session.generatingVariants.add(variant.key);
  const created = [];
  try {
    for (const variant of variants) {
      const outDir = path.join(session.dir, variant.key);
      await mkdir(outDir, { recursive: true });
      variant.dir = outDir;
      try { if ((await stat(path.join(outDir, "index.m3u8"))).size > 0) continue; } catch {}
      variant.created = true;
      created.push(variant);
      const child = spawn("ffmpeg", hlsArguments(session, variant, { ...options, size: variant.size }, outDir), { stdio: ["ignore", "ignore", "ignore"] });
      job.child = child;
      child.once("error", () => {});
      await waitForPlaylist(path.join(outDir, "index.m3u8"), child);
    }
    if (!res.headersSent) res.type("application/vnd.apple.mpegurl").set("Cache-Control", "no-store").send(masterPlaylist(variants, session, options.audioTrack, options.audioOnly));
    done();
  } catch {
    for (const variant of created) if (variant.dir) await rm(variant.dir, { recursive: true, force: true });
    if (!res.headersSent) publicError(res, 502, "unable to create HLS stream");
    done();
  } finally {
    for (const variant of variants) session.generatingVariants.delete(variant.key);
  }
}

async function serveCaption(req, res, session) {
  const format = String(req.query.format || "vtt").toLowerCase();
  const id = String(req.query.track || "");
  if (!["vtt", "srt"].includes(format)) return publicError(res, 400, "unsupported caption format");
  const job = acquireJob(session, res);
  if (!job) return;
  cancelOnDisconnect(req, res, job);
  try {
  const native = session.captions.find((track) => track.id === id);
  if (native?.streamIndex != null) {
    const codec = format === "vtt" ? "webvtt" : "srt";
    try {
      const bytes = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", session.file, "-map", `0:${native.streamIndex}`, "-f", codec, "pipe:1"], { maxOutput: MAX_SUBTITLE_BYTES, onChild: (child) => { job.child = child; } });
      return res.type(format === "vtt" ? "text/vtt" : "application/x-subrip").send(bytes);
    } catch { return publicError(res, 404, "caption unavailable"); }
  }
  const external = session.sourceCaptions?.find((track) => track.id === id);
  if (!external) return publicError(res, 404, "caption unavailable");
  try {
    const bytes = await fetchLimited(external.url, external.headers, MAX_SUBTITLE_BYTES, job.controller.signal);
    const input = path.join(session.dir, `caption-${randomBytes(8).toString("hex")}.${external.ext || "vtt"}`);
    await pipeline((await import("node:stream")).Readable.from(bytes), createWriteStream(input, { flags: "wx" }));
    const args = ["-hide_banner", "-loglevel", "error", "-i", input, "-f", format === "vtt" ? "webvtt" : "srt", "pipe:1"];
    const converted = await run("ffmpeg", args, { maxOutput: MAX_SUBTITLE_BYTES, onChild: (child) => { job.child = child; } });
    await unlink(input).catch(() => {});
    return res.type(format === "vtt" ? "text/vtt" : "application/x-subrip").send(converted);
  } catch { return publicError(res, 404, "caption unavailable"); }
  } finally {
    finishJob(session, job);
  }
}

async function serveDanmaku(req, res, session) {
  const job = acquireJob(session, res);
  if (!job) return;
  cancelOnDisconnect(req, res, job);
  try {
  if (!session.danmaku) return res.type("application/xml").send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><i></i>");
  try {
    const bytes = await fetchLimited(session.danmaku.url, session.danmaku.headers, MAX_DANMAKU_BYTES, job.controller.signal);
    const text = bytes.toString("utf8");
    if (!/^\s*(?:<\?xml[^>]*>\s*)?<i(?:\s|>)/i.test(text)) throw new Error("invalid danmaku");
    return res.type("application/xml").send(bytes);
  } catch { return res.type("application/xml").send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><i></i>"); }
  } finally {
    finishJob(session, job);
  }
}

export function registerMediaRoutes(app, authGate) {
  app.post("/media/resolve", authGate, express.json({ limit: "4kb" }), handleResolve);
  app.post("/media/files", authGate, handleUpload);
  app.get("/media/sessions/:id/stream", authGate, (req, res) => {
    const session = getSession(req, res);
    if (!session) return;
    const options = validatePlaybackOptions(req, session, res);
    if (!options) return;
    if (session.kind === "native" && path.extname(session.file).toLowerCase() === ".mp4" && !options.format && !options.timeOffset && !options.bitRate && !options.size && !options.audioTrack) return sendNativeRange(req, res, session);
    return streamMedia(req, res, session, options);
  });
  app.get("/media/sessions/:id/hls.m3u8", authGate, (req, res) => {
    const session = getSession(req, res);
    if (!session) return;
    const audioTrack = audioIndex(session, req.query.audioTrack);
    if (req.query.audioTrack != null && !audioTrack) return publicError(res, 400, "unknown audio track");
    const audioOnly = req.query.audioOnly === "1";
    if (audioOnly && session.audioTracks.length === 0) return publicError(res, 422, "audio track unavailable");
    return serveHls(req, res, session, { audioTrack: audioTrack?.id, audioOnly });
  });
  app.get("/media/sessions/:id/file/:variant/:filename", authGate, async (req, res) => {
    const session = getSession(req, res);
    if (!session) return;
    if (!/^[0-9]{2,5}-[0-9]{1,5}x[0-9]{1,5}$/.test(req.params.variant) || !/^(?:index\.m3u8|init\.mp4|seg-\d{5}\.m4s)$/.test(req.params.filename)) return publicError(res, 404, "media file not found");
    const root = path.resolve(session.dir, req.params.variant);
    const file = path.resolve(root, req.params.filename);
    if (!file.startsWith(`${root}${path.sep}`)) return publicError(res, 404, "media file not found");
    try {
      const fileStat = await stat(file);
      if (!fileStat.isFile() || fileStat.size > 512 * 1024 * 1024) return publicError(res, 404, "media file not found");
      return res.type(path.extname(file) === ".m3u8" ? "application/vnd.apple.mpegurl" : path.extname(file) === ".mp4" ? "video/mp4" : "video/iso.segment").set("Cache-Control", "no-store").sendFile(file);
    } catch { return publicError(res, 404, "media file not found"); }
  });
  app.get("/media/sessions/:id/captions", authGate, (req, res) => {
    const session = getSession(req, res);
    return session ? serveCaption(req, res, session) : undefined;
  });
  app.get("/media/sessions/:id/danmaku", authGate, (req, res) => {
    const session = getSession(req, res);
    return session ? serveDanmaku(req, res, session) : undefined;
  });
  app.delete("/media/sessions/:id", authGate, async (req, res) => {
    const session = getSession(req, res);
    if (!session) return;
    await removeSession(session);
    return res.status(204).end();
  });
}
