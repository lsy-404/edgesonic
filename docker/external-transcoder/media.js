import express from "express";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, statSync } from "node:fs";
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
const MAX_SESSION_HLS_VARIANTS = 8;
const MAX_SESSION_HLS_QUEUED_JOBS = 4;
const MAX_DANMAKU_BYTES = 4 * 1024 * 1024;
const MAX_SUBTITLE_BYTES = 16 * 1024 * 1024;
const ID_PATTERN = /^[a-f0-9]{48}$/;
const VIDEO_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.bilibili.com", "bilibili.com", "m.bilibili.com", "www.bilibili.tv", "bilibili.tv", "m.bilibili.tv"]);
const BILI_HOSTS = new Set(["b23.tv", "www.b23.tv", "bilibili.com", "www.bilibili.com", "m.bilibili.com", "bilibili.tv", "www.bilibili.tv", "m.bilibili.tv"]);
const EXTERNAL_MEDIA_HOSTS = ["youtube.com", "googlevideo.com", "googleusercontent.com", "bilibili.com", "bilivideo.com", "bilivideo.cn", "biliapi.net", "hdslb.com"];
const sessions = new Map();
const activeJobs = new Set();
const jobWaiters = [];
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
    if (!isSecureVideoUrl(current) || !allowedHost(current.hostname, BILI_HOSTS)) throw new Error("unsupported URL");
    const response = await fetch(current, { method: "GET", redirect: "manual", headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(8000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("invalid redirect");
      current = new URL(location, current);
      if (!isSecureVideoUrl(current) || !allowedHost(current.hostname, BILI_HOSTS)) throw new Error("unsupported redirect");
      continue;
    }
    await response.body?.cancel();
    return current;
  }
  throw new Error("too many redirects");
}

function isSecureVideoUrl(url) {
  return url.protocol === "https:" && !url.username && !url.password && !url.port;
}

async function normalizeSource(value) {
  const trimmed = value.trim();
  const bv = /^BV[0-9A-Za-z]{10}$/.test(trimmed) ? trimmed : null;
  const avMatch = /^av\s*([0-9]{1,20})$/i.exec(trimmed);
  const av = avMatch ? `av${avMatch[1]}` : null;
  if (bv || av) return `https://www.bilibili.com/video/${bv || av}/?p=1`;
  let url;
  try { url = new URL(trimmed); } catch { throw new Error("invalid URL"); }
  if (!isSecureVideoUrl(url)) throw new Error("unsupported URL");
  if (allowedHost(url.hostname, new Set(["b23.tv", "www.b23.tv"]))) url = await resolveShortUrl(url.href);
  if (!allowedHost(url.hostname, VIDEO_HOSTS)) throw new Error("unsupported URL");
  if (url.hostname === "m.bilibili.com") url.hostname = "www.bilibili.com";
  if (url.hostname === "m.bilibili.tv") url.hostname = "www.bilibili.tv";
  if (BILI_HOSTS.has(url.hostname)) {
    const avPath = /^\/(?:video\/)?av(?:%20|\s)([0-9]{1,20})\/?$/i.exec(url.pathname);
    if (avPath) url.pathname = `/video/av${avPath[1]}/`;
  }
  const isYoutube = url.hostname.includes("youtube") || url.hostname === "youtu.be";
  if (url.hostname.endsWith("youtube.com") && !["/watch", "/shorts/", "/embed/", "/live/"].some((part) => url.pathname.startsWith(part))) throw new Error("unsupported URL");
  if (url.pathname.startsWith("/playlist/")) throw new Error("unsupported URL");
  if (isYoutube && url.searchParams.has("list")) {
    if (url.pathname !== "/watch" || !url.searchParams.has("v")) throw new Error("unsupported URL");
    url.searchParams.delete("list");
  }
  if (url.hostname === "youtu.be" && url.pathname.length < 2) throw new Error("unsupported URL");
  if (!isYoutube) {
    if (!/^\/(video\/)?(BV[0-9A-Za-z]{10}|av[0-9]{1,20})(?:\/|$)/.test(url.pathname)) throw new Error("unsupported URL");
    const parts = url.searchParams.getAll("p");
    if (parts.length > 1 || (parts.length === 1 && !/^[1-9][0-9]*$/.test(parts[0]))) throw new Error("invalid part");
    if (!parts.length) url.searchParams.set("p", "1");
  }
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

function nativeDemuxer(file) {
  const extension = path.extname(file).toLowerCase();
  if ([".mp4", ".mov", ".m4v"].includes(extension)) return "mov";
  if ([".mkv", ".webm"].includes(extension)) return "matroska";
  if (extension === ".avi") return "avi";
  throw new Error("unsupported native container");
}

function ffprobe(file) {
  return runJson("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-f", nativeDemuxer(file), "-show_streams", "-show_format", "-of", "json", file]);
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
  const session = { ...data, id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS, jobs: new Set(), generatingVariants: new Map(), hlsVariantKeys: new Set(), timer: null };
  session.timer = setTimeout(() => removeSession(session), SESSION_TTL_MS).unref();
  sessions.set(id, session);
  return session;
}

async function removeSession(session) {
  if (!session) return;
  clearTimeout(session.timer);
  sessions.delete(session.id);
  const jobs = [...session.jobs];
  for (const job of jobs) {
    job.child?.kill("SIGKILL");
    job.controller.abort();
    if (!job.child) finishJob(session, job);
  }
  await Promise.all(jobs.map(async (job) => {
    if (job.child) await waitForChild(job.child);
    finishJob(session, job);
  }));
  await rm(session.dir, { recursive: true, force: true }).catch(() => {});
}

function getSession(req, res) {
  if (!ID_PATTERN.test(req.params.id)) { publicError(res, 404, "session not found"); return null; }
  const session = sessions.get(req.params.id);
  if (!session || session.expiresAt <= Date.now()) { if (session) void removeSession(session); publicError(res, 404, "session not found"); return null; }
  return session;
}

function createJob(session) {
  const job = { child: null, session, controller: new AbortController() };
  session.jobs.add(job);
  return job;
}

function activateJob(job) {
  const index = jobWaiters.indexOf(job);
  if (index >= 0) jobWaiters.splice(index, 1);
  job.waiterCleanup?.();
  job.waiterCleanup = null;
  job.active = true;
  activeJobs.add(job);
}

function drainJobWaiters() {
  while (activeJobs.size < MAX_ACTIVE_JOBS && jobWaiters.length) {
    const job = jobWaiters.shift();
    job.waiterCleanup?.();
    job.waiterCleanup = null;
    if (job.finished || job.controller.signal.aborted) {
      job.waiterReject?.(new Error("media job cancelled"));
      continue;
    }
    job.active = true;
    activeJobs.add(job);
    job.waiterResolve();
  }
}

function waitForJobSlot(job) {
  if (job.controller.signal.aborted) return Promise.reject(new Error("media job cancelled"));
  if (activeJobs.size < MAX_ACTIVE_JOBS && jobWaiters.length === 0) {
    job.active = true;
    activeJobs.add(job);
    return Promise.resolve();
  }
  if (job.kind === "hls" && jobWaiters.filter((waiting) => waiting.session === job.session && waiting.kind === "hls").length >= MAX_SESSION_HLS_QUEUED_JOBS) return Promise.reject(new Error("too many queued HLS jobs"));
  return new Promise((resolve, reject) => {
    job.waiterResolve = resolve;
    job.waiterReject = reject;
    const abort = () => {
      const index = jobWaiters.indexOf(job);
      if (index >= 0) jobWaiters.splice(index, 1);
      job.waiterCleanup?.();
      job.waiterCleanup = null;
      reject(new Error("media job cancelled"));
    };
    job.waiterCleanup = () => job.controller.signal.removeEventListener("abort", abort);
    jobWaiters.push(job);
    job.controller.signal.addEventListener("abort", abort, { once: true });
  });
}

function acquireJob(session, res) {
  if (activeJobs.size >= MAX_ACTIVE_JOBS || jobWaiters.length > 0) { publicError(res, 429, "media workers busy"); return null; }
  const job = createJob(session);
  activateJob(job);
  return job;
}

function finishJob(session, job) {
  if (job.finished) return;
  job.finished = true;
  const waiting = jobWaiters.indexOf(job);
  if (waiting >= 0) {
    jobWaiters.splice(waiting, 1);
    job.waiterCleanup?.();
    job.waiterReject?.(new Error("media job cancelled"));
  }
  session.jobs.delete(job);
  if (activeJobs.delete(job)) drainJobWaiters();
}

function waitForChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
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
  else args.push("-protocol_whitelist", "file,pipe", "-f", nativeDemuxer(session.file), "-i", session.file);
  return args;
}

function ffmpegAudioInputs(session, selected) {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  if (selected.video) { addHeaderArgs(args, selected.audio.headers); args.push("-i", selected.audio.url); }
  else args.push("-protocol_whitelist", "file,pipe", "-f", nativeDemuxer(session.file), "-i", session.file);
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
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel().catch(() => {});
    throw new Error("media resource unavailable");
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximum) { await response.body?.cancel(); throw new Error("media resource too large"); }
  const chunks = [];
  let size = 0;
  if (!response.body) return Buffer.alloc(0);
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) throw new Error("media resource too large");
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
    const info = await runJson("yt-dlp", ["--ignore-config", "--no-warnings", "--no-playlist", "--skip-download", "--no-progress", "--js-runtimes", "node", "--dump-single-json", source]);
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
  if (!/^video\/(mp4|webm|quicktime|x-matroska|x-m4v|x-msvideo|avi)$/.test(type) && !["application/octet-stream", "application/x-matroska", "video/matroska"].includes(type)) return publicError(res, 415, "unsupported video type");
  const length = Number(req.get("Content-Length"));
  if (Number.isFinite(length) && length > MAX_UPLOAD_BYTES) return publicError(res, 413, "video too large");
  const rawSuffix = String(req.query.suffix || "").trim().toLowerCase();
  const suffix = rawSuffix ? (rawSuffix.startsWith(".") ? rawSuffix : `.${rawSuffix}`) : "";
  if (![".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi"].includes(suffix)) return publicError(res, 400, "invalid suffix");
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
  const close = () => {
    if (!res.writableEnded && job.child && !job.child.killed) job.child.kill("SIGKILL");
    if (!job.child || job.child.exitCode !== null || job.child.signalCode !== null) done();
  };
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
  args.push("-f", "hls", "-hls_time", "4", "-hls_list_size", "0", "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", path.join(outDir, "seg-%05d.m4s"), path.join(outDir, "index.m3u8"));
  return args;
}

function validateVariants(values, session, options, res) {
  const raw = values.length ? values : [options.audioOnly ? "192" : "1200"];
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
    const audioTrack = options.audioTrack || session.audioTracks[0]?.id || "none";
    const trackKey = createHash("sha256").update(String(audioTrack)).digest("hex").slice(0, 20);
    variant.key = `${options.audioOnly ? "audio" : "video"}-${trackKey}-${rate}-${outputSize?.width || 0}x${outputSize?.height || 0}`;
    if (variants.some((item) => item.key === variant.key)) { publicError(res, 400, "duplicate HLS variant"); return null; }
    variants.push(variant);
  }
  const newKeys = variants.filter((variant) => !session.hlsVariantKeys.has(variant.key));
  if (session.hlsVariantKeys.size + newKeys.length > MAX_SESSION_HLS_VARIANTS) { publicError(res, 429, "too many HLS variants"); return null; }
  return variants;
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

function ensureHlsVariant(session, variant, options) {
  const current = session.generatingVariants.get(variant.key);
  if (current) return current.ready;
  const outDir = path.join(session.dir, variant.key);
  try { if (statSync(path.join(outDir, "index.m3u8")).size > 0) return Promise.resolve(); } catch {}
  if (!session.hlsVariantKeys.has(variant.key) && session.hlsVariantKeys.size >= MAX_SESSION_HLS_VARIANTS) return Promise.reject(new Error("too many HLS variants"));
  session.hlsVariantKeys.add(variant.key);
  const state = {};
  state.ready = new Promise((resolve, reject) => { state.resolve = resolve; state.reject = reject; });
  state.ready.catch(() => {});
  session.generatingVariants.set(variant.key, state);
  void generateHlsVariant(session, variant, options, outDir, state);
  return state.ready;
}

async function generateHlsVariant(session, variant, options, outDir, state) {
  const job = createJob(session);
  job.kind = "hls";
  state.job = job;
  let child;
  let playlistReady = false;
  let timedOut = false;
  let diskExceeded = false;
  const deadline = Date.now() + 45000;
  try {
    await waitForJobSlot(job);
    if (job.controller.signal.aborted || !sessions.has(session.id)) throw new Error("media job cancelled");
    await mkdir(outDir, { recursive: true });
    if (job.controller.signal.aborted || !sessions.has(session.id)) throw new Error("media job cancelled");
    child = spawn("ffmpeg", hlsArguments(session, variant, { ...options, size: variant.size }, outDir), { stdio: ["ignore", "ignore", "ignore"] });
    job.child = child;
    child.once("error", () => {});
    const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    let exit = null;
    while (!exit) {
      if (job.controller.signal.aborted) child.kill("SIGKILL");
      if (await directorySize(session.dir) > MAX_SESSION_DISK_BYTES) {
        diskExceeded = true;
        child.kill("SIGKILL");
      }
      if (!playlistReady) {
        try {
          if ((await stat(path.join(outDir, "index.m3u8"))).size > 0) {
            playlistReady = true;
            state.resolve();
          }
        } catch {}
        if (!playlistReady && Date.now() >= deadline) {
          timedOut = true;
          child.kill("SIGKILL");
        }
      }
      exit = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(null), 250))]);
    }
    if (!playlistReady) {
      try {
        if ((await stat(path.join(outDir, "index.m3u8"))).size > 0) {
          playlistReady = true;
          state.resolve();
        }
      } catch {}
    }
    if (job.controller.signal.aborted || timedOut || diskExceeded || exit.code !== 0 || !playlistReady) throw new Error("HLS generation failed");
  } catch (error) {
    child?.kill("SIGKILL");
    if (child) await waitForChild(child);
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
    if (!playlistReady) {
      session.hlsVariantKeys.delete(variant.key);
      state.reject(error);
    }
  } finally {
    finishJob(session, job);
    if (session.generatingVariants.get(variant.key) === state) session.generatingVariants.delete(variant.key);
  }
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
  const variants = validateVariants([].concat(req.query.bitRate || []), session, options, res);
  if (!variants) return;
  try {
    await Promise.all(variants.map((variant) => ensureHlsVariant(session, variant, options)));
    res.type("application/vnd.apple.mpegurl").set("Cache-Control", "no-store").send(masterPlaylist(variants, session, options.audioTrack, options.audioOnly));
  } catch {
    if (!res.headersSent) publicError(res, 502, "unable to create HLS stream");
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
      const bytes = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-f", nativeDemuxer(session.file), "-i", session.file, "-map", `0:${native.streamIndex}`, "-f", codec, "pipe:1"], { maxOutput: MAX_SUBTITLE_BYTES, onChild: (child) => { job.child = child; } });
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
  if (!session.danmaku) return res.type("application/xml").send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><i></i>");
  const job = acquireJob(session, res);
  if (!job) return;
  cancelOnDisconnect(req, res, job);
  try {
  try {
    const bytes = await fetchLimited(session.danmaku.url, session.danmaku.headers, MAX_DANMAKU_BYTES, job.controller.signal);
    const text = bytes.toString("utf8");
    if (!/^\s*(?:<\?xml[^>]*>\s*)?<i(?:\s|>)/i.test(text)) throw new Error("invalid danmaku");
    return res.type("application/xml").send(bytes);
  } catch { return publicError(res, 502, "danmaku unavailable"); }
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
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(req.params.variant) || !/^(?:index\.m3u8|init\.mp4|seg-\d{5}\.m4s)$/.test(req.params.filename)) return publicError(res, 404, "media file not found");
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
