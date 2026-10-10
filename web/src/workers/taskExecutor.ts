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


import { parseBuffer } from "music-metadata";
import { commonArtistsToTag, lyricsTagsToText, nativeLyricsFallback } from "../lib/metadata";
import { convertIntegerPcmWav, loadFfmpeg } from "../lib/wavFlacConvertEngine";
import { runMetadataRetrieval } from "../lib/workmodeMetadataRetrieval";

interface Task {
  id: string;
  taskType: "metadata" | "transcode" | "scrape" | "lossless";
  payload: Record<string, unknown>;
}

const ERR_LIMIT = 500;
function clampMsg(s: string): string {
  return s.length > ERR_LIMIT ? s.slice(0, ERR_LIMIT) : s;
}

self.addEventListener("message", async (e: MessageEvent<Task>) => {
  if ((e.data as unknown as { cancel?: boolean }).cancel) {
    activeTaskController?.abort();
    return;
  }
  const task = e.data;
  activeTaskController = new AbortController();
  try {
    let result: unknown;
    switch (task.taskType) {
      case "metadata":
        result = await runMetadata(task.payload);
        break;
      case "transcode":
        result = await runTranscode(task.payload);
        break;
      case "scrape":
        result = await runScrape(task.payload);
        break;
      case "lossless":
        result = await runLossless(task.payload);
        break;
      default:
        throw new Error(`unknown task_type: ${task.taskType}`);
    }
    (self as unknown as Worker).postMessage({ ok: true, result });
  } catch (e) {
    const raw = e instanceof Error
      ? (e.message || e.toString())
      : String(e);
    (self as unknown as Worker).postMessage({ ok: false, error: clampMsg(raw) });
  } finally {
    activeTaskController = null;
  }
});

let activeTaskController: AbortController | null = null;

self.addEventListener("error", (e: ErrorEvent) => {
  const msg = e.message || (e.error instanceof Error ? e.error.message : "")
    || "worker fired error event (no message)";
  (self as unknown as Worker).postMessage({ ok: false, error: clampMsg(msg) });
});

self.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
  const reason = e.reason;
  const msg = reason instanceof Error
    ? (reason.message || reason.toString())
    : (typeof reason === "string" ? reason : `unhandled rejection: ${String(reason)}`);
  (self as unknown as Worker).postMessage({ ok: false, error: clampMsg(msg) });
});

function firstMoofBoxStart(buf: Uint8Array): number {
  for (let i = 4; i < buf.length - 3; i++) {
    if (buf[i] === 0x6d && buf[i + 1] === 0x6f && buf[i + 2] === 0x6f && buf[i + 3] === 0x66) {
      return i - 4;
    }
  }
  return -1;
}

function detectedMimeType(buf: Uint8Array, suffix: string, hinted?: string): string | undefined {
  const isIsoBmff = buf.length >= 8 &&
    buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
  if (!isIsoBmff) return hinted;
  return suffix === "mp4" ? "video/mp4" : "audio/mp4";
}

export function isMetaEmpty(m: Awaited<ReturnType<typeof parseBuffer>>): boolean {
  const c = m.common;
  const hasText = !!(c.title || c.artist || (c.artists && c.artists.length) || c.album || c.albumartist ||
    (c.genre && c.genre.length) || c.year || c.track?.no || c.disk?.no);
  const hasPicture = !!(c.picture && c.picture.length);
  const hasLyrics = !!(lyricsTagsToText(c.lyrics) || nativeLyricsFallback(m.native));
  return !hasText && !hasPicture && !hasLyrics;
}

function declaredPcmWavMetrics(bytes: Uint8Array, fileSize: number): { duration: number; bitrate: number } | undefined {
  if (fileSize <= bytes.length || bytes.length < 12) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (ascii(0) !== "RIFF" || ascii(8) !== "WAVE") return undefined;
  const riffEnd = 8 + view.getUint32(4, true);
  if (riffEnd > fileSize || riffEnd < 12) return undefined;

  let offset = 12;
  let sampleRate = 0;
  let byteRate = 0;
  let blockAlign = 0;
  let formatTag = 0;
  let channels = 0;
  let bitsPerSample = 0;
  while (offset + 8 <= bytes.length && offset + 8 <= riffEnd) {
    const id = ascii(offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;
    const chunkEnd = body + chunkSize;
    if (chunkEnd > riffEnd || chunkEnd > fileSize) return undefined;
    if (id === "fmt ") {
      if (chunkSize < 16 || chunkEnd > bytes.length) return undefined;
      formatTag = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      byteRate = view.getUint32(body + 8, true);
      blockAlign = view.getUint16(body + 12, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === "data") {
      if (formatTag !== 1 && formatTag !== 3) return undefined;
      const validBits = formatTag === 1
        ? bitsPerSample === 8 || bitsPerSample === 16 || bitsPerSample === 24 || bitsPerSample === 32
        : bitsPerSample === 32 || bitsPerSample === 64;
      if (!channels || !sampleRate || !validBits || blockAlign !== channels * bitsPerSample / 8 ||
          !chunkSize || byteRate !== sampleRate * blockAlign || chunkSize % blockAlign !== 0) return undefined;
      return { duration: chunkSize / blockAlign / sampleRate, bitrate: byteRate * 8 };
    }
    offset = chunkEnd + (chunkSize & 1);
  }
  return undefined;
}

export async function runMetadata(payload: Record<string, unknown>): Promise<unknown> {
  const sourceUri = String(payload.sourceUri || "");
  const instanceId = String(payload.instanceId || "");
  if (!sourceUri) throw new Error("metadata task missing sourceUri");
  if (!instanceId) throw new Error("metadata task missing instanceId");

  const streamUrl = String(payload.streamUrl || "");
  if (!streamUrl) throw new Error("metadata task missing streamUrl (main thread should populate)");

  const suffix = String(payload.suffix || "").toLowerCase();
  const isWav = suffix === "wav";
  const isMp4Family = ["m4a", "m4b", "mp4", "alac"].includes(suffix);
  const HEAD_BYTES = 2 * 1024 * 1024; // 2MB — covers large ID3v2 + APIC
  const TAIL_BYTES = 2 * 1024 * 1024; // 2MB — trailing id3/INFO chunk (may include embedded art)

  const headResp = await fetch(streamUrl, {
    headers: { Range: `bytes=0-${HEAD_BYTES - 1}` },
  });
  if (!headResp.ok && headResp.status !== 206 && headResp.status !== 200) {
    throw new Error(`stream fetch failed: HTTP ${headResp.status}`);
  }
  let buf = new Uint8Array(await headResp.arrayBuffer());

  const contentRange = headResp.headers.get("content-range");
  const rangeTotalMatch = contentRange ? /\/(\d+)\s*$/.exec(contentRange) : null;
  const totalSize = rangeTotalMatch
    ? parseInt(rangeTotalMatch[1], 10)
    : (Number(payload.size) || 0);
  const isPartialMp3 = suffix === "mp3" &&
    ((headResp.status === 206 && (!totalSize || buf.length < totalSize)) || (totalSize > 0 && buf.length < totalSize));
  const headAlreadyHadWholeFile = (headResp.status === 200 && (!totalSize || buf.length === totalSize)) ||
    (totalSize > 0 && buf.length === totalSize);
  const FULL_FETCH_CAP_BYTES = 300 * 1024 * 1024;
  let durationReadFromCompleteFile = !isPartialMp3 && (!isMp4Family || headAlreadyHadWholeFile);

  if (isWav && totalSize > buf.length) {
    try {
      const tailStart = Math.max(buf.length, totalSize - TAIL_BYTES);
      const tailResp = await fetch(streamUrl, {
        headers: { Range: `bytes=${tailStart}-${totalSize - 1}` },
      });
      if (tailResp.ok || tailResp.status === 206) {
        const tailBuf = new Uint8Array(await tailResp.arrayBuffer());
        const gap = totalSize - buf.length - tailBuf.length;
        if (gap >= 0 && gap < 100 * 1024 * 1024) { // sanity: don't alloc >100MB
          const combined = new Uint8Array(buf.length + gap + tailBuf.length);
          combined.set(buf, 0);
          combined.set(tailBuf, buf.length + gap);
          buf = combined;
        }
      }
    } catch { /* tail fetch optional — head alone still works for duration */ }
  }

  const mimeType = detectedMimeType(buf, suffix, headResp.headers.get("content-type") || undefined);
  const partialWavMetrics = isWav && totalSize > buf.length
    ? declaredPcmWavMetrics(buf, totalSize)
    : undefined;
  let meta;
  try {
    meta = await parseBuffer(buf, {
      mimeType,
      size: totalSize > buf.length ? totalSize : undefined,
    }, { duration: !isPartialMp3, skipCovers: false });
  } catch (parseErr) {
    try {
      meta = await parseBuffer(buf, {
        mimeType,
        size: totalSize > buf.length ? totalSize : undefined,
      }, { duration: false, skipCovers: false });
    } catch {
      const cut = firstMoofBoxStart(buf);
      if (cut <= 16) {
        throw new Error(`metadata parse failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
      }
      try {
        meta = await parseBuffer(buf.slice(0, cut), { mimeType, size: cut }, { duration: false, skipCovers: false });
      } catch {
        throw new Error(`metadata parse failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
      }
    }
  }

  const needsCompleteDurationRead = isPartialMp3 || (isMp4Family && !headAlreadyHadWholeFile);
  if (needsCompleteDurationRead && totalSize > 0 && totalSize <= FULL_FETCH_CAP_BYTES) {
    try {
      const fullResp = await fetch(streamUrl);
      if (fullResp.status === 200) {
        const fullBuf = new Uint8Array(await fullResp.arrayBuffer());
        if (fullBuf.length === totalSize) {
          const fullMimeType = detectedMimeType(fullBuf, suffix, fullResp.headers.get("content-type") || mimeType);
          try {
            meta = await parseBuffer(fullBuf, { mimeType: fullMimeType, size: fullBuf.length }, { duration: true, skipCovers: false });
            durationReadFromCompleteFile = true;
          } catch {
            const tagsOnly = await parseBuffer(fullBuf, { mimeType: fullMimeType, size: fullBuf.length }, { duration: false, skipCovers: false }).catch(() => undefined);
            if (tagsOnly) meta = tagsOnly;
          }
        }
      }
    } catch { /* retain ranged tags and omit the unverified duration */ }
  }

  if (!isMp4Family && !isPartialMp3 && isMetaEmpty(meta) &&
      !headAlreadyHadWholeFile && totalSize > 0 && totalSize <= FULL_FETCH_CAP_BYTES) {
    try {
      const fullResp = await fetch(streamUrl);
      if (fullResp.ok) {
        const fullBuf = new Uint8Array(await fullResp.arrayBuffer());
        if (fullBuf.length === totalSize) {
          const fullMimeType = detectedMimeType(fullBuf, suffix, fullResp.headers.get("content-type") || undefined);
          let fullMeta;
          try {
            fullMeta = await parseBuffer(fullBuf, { mimeType: fullMimeType }, { duration: true, skipCovers: false });
          } catch {
            fullMeta = await parseBuffer(fullBuf, { mimeType: fullMimeType }, { duration: false, skipCovers: false }).catch(() => undefined);
          }
          if (fullMeta && (!isMetaEmpty(fullMeta) || (fullMeta.format.duration && fullMeta.format.duration > 0))) meta = fullMeta;
        }
      }
    } catch { /* full-file fetch/parse failed — keep the original (empty) result */ }
  }

  let coverData: string | null = null;
  let coverMime: string | null = null;
  const pic: { data?: Uint8Array; format?: string } | undefined =
    meta.common.picture?.[0] as { data?: Uint8Array; format?: string } | undefined;
  if (pic && pic.data) {
    const bytes = pic.data instanceof Uint8Array ? pic.data : new Uint8Array(pic.data as ArrayBuffer);
    if (bytes.byteLength > 0 && bytes.byteLength <= 200_000) {
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      coverData = btoa(bin);
      coverMime = (pic.format || "image/jpeg").replace(/^image\//, "image/");
    }
  }

  const duration = isWav && totalSize > buf.length
    ? partialWavMetrics?.duration ? Math.round(partialWavMetrics.duration) : undefined
    : (isPartialMp3 || isMp4Family ? durationReadFromCompleteFile : true) && meta.format.duration
      ? Math.round(meta.format.duration)
    : undefined;
  return {
    instanceId,
    tags: {
      title:       meta.common.title || "",
      artist:      commonArtistsToTag(meta.common.artist, meta.common.artists) || "",
      album:       meta.common.album || "",
      albumArtist: meta.common.albumartist || "",
      genre:       (meta.common.genre || []).join(", "),
      year:        meta.common.year ? String(meta.common.year) : "",
      track:       meta.common.track?.no ? String(meta.common.track.no) : "",
      disc:        meta.common.disk?.no ? String(meta.common.disk.no) : "",
      lyrics:      lyricsTagsToText(meta.common.lyrics) || nativeLyricsFallback(meta.native) || "",
      ...(duration ? { duration } : {}),
      ...((isMp4Family && !durationReadFromCompleteFile) ? {} : {
        bitrate: isWav && totalSize > buf.length
          ? partialWavMetrics ? Math.round(partialWavMetrics.bitrate / 1000) : 0
          : meta.format.bitrate ? Math.round(meta.format.bitrate / 1000) : 0,
      }),
      sampleRate:  meta.format.sampleRate || 0,
      ...(Number.isFinite(meta.format.bitsPerSample) && (meta.format.bitsPerSample ?? 0) > 0
        ? { bitDepth: meta.format.bitsPerSample }
        : {}),
      channels:    meta.format.numberOfChannels || 0,
      container:   meta.format.container || "",
      codec:       meta.format.codec || "",
    },
    cover: coverData ? { data: coverData, mime: coverMime } : null,
  };
}

async function runTranscode(payload: Record<string, unknown>): Promise<unknown> {
  const sourceUri = String(payload.sourceUri || "");
  const uploadUrl = String(payload.uploadUrl || "");
  const outputSuffix = String(payload.outputSuffix || "");
  const ffmpegArgs = Array.isArray(payload.ffmpegArgs)
    ? (payload.ffmpegArgs as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  if (!sourceUri) throw new Error("transcode task missing sourceUri");
  if (!uploadUrl) throw new Error("transcode task missing uploadUrl");
  if (!outputSuffix) throw new Error("transcode task missing outputSuffix");
  if (ffmpegArgs.length === 0) throw new Error("transcode task missing ffmpegArgs");

  const { FFmpeg } = await import("@ffmpeg/ffmpeg");
  const ff = new FFmpeg();
  let releaseAssets: (() => void) | undefined;
  const signal = activeTaskController?.signal;
  const terminateOnAbort = () => ff.terminate();
  signal?.addEventListener("abort", terminateOnAbort, { once: true });
  try {
    releaseAssets = await loadFfmpeg(ff, signal);

    const resp = await fetch(sourceUri, { signal });
    if (!resp.ok) throw new Error(`source fetch failed: HTTP ${resp.status}`);
    const inputBuf = new Uint8Array(await resp.arrayBuffer());

    const inputName = "in.src";
    const outputName = "out." + outputSuffix;
    await ff.writeFile(inputName, inputBuf);
    const patchedArgs = ffmpegArgs.map((a) =>
      a === "pipe:0" ? inputName : a === "pipe:1" ? outputName : a,
    );

    const exitCode = await ff.exec(patchedArgs);
    if (exitCode !== 0) throw new Error(`transcode failed with exit code ${exitCode}`);
    const out = await ff.readFile(outputName);
    if (typeof out === "string") {
      throw new Error("ffmpeg readFile returned string; expected Uint8Array");
    }
    const outBytes: Uint8Array<ArrayBuffer> = new Uint8Array(out);

    const uploadResp = await fetch(uploadUrl, {
      method: "POST",
      body: outBytes,
      headers: { "Content-Type": "application/octet-stream" },
      signal,
    });
    if (!uploadResp.ok) {
      const body = await uploadResp.text().catch(() => "");
      throw new Error(`upload failed: HTTP ${uploadResp.status} ${body.slice(0, 200)}`);
    }
    const uploadJson = await uploadResp.json() as {
      ok?: boolean;
      registered?: boolean;
      r2Key?: string;
      size?: number;
      instanceId?: string | null;
    };
    if (uploadJson.ok !== true || uploadJson.registered !== true || !uploadJson.r2Key
      || !uploadJson.instanceId || uploadJson.size !== outBytes.byteLength) {
      throw new Error("transcode upload was not registered with a complete receipt");
    }
    return {
      r2Key: uploadJson.r2Key,
      size: uploadJson.size,
      instanceId: uploadJson.instanceId,
    };
  } finally {
    signal?.removeEventListener("abort", terminateOnAbort);
    ff.terminate();
    releaseAssets?.();
  }
}

async function runLossless(payload: Record<string, unknown>): Promise<unknown> {
  const sourceUri = String(payload.streamUrl || "");
  const uploadUrl = String(payload.uploadUrl || "");
  const instanceId = String(payload.instanceId || "");
  if (!sourceUri || !instanceId) throw new Error("lossless task missing source instance stream");
  if (!uploadUrl) throw new Error("lossless task missing signed upload URL");

  const signal = activeTaskController?.signal;
  const response = await fetch(sourceUri, { signal });
  if (!response.ok) throw new Error(`source fetch failed: HTTP ${response.status}`);
  const source = new Uint8Array(await response.arrayBuffer());
  const expectedSize = payload.sourceSize ?? payload.size;
  if (expectedSize !== undefined && Number(expectedSize) !== source.byteLength) {
    throw new Error("source size no longer matches the queued snapshot; conversion was discarded");
  }

  const { flac, evidence } = await convertIntegerPcmWav(source, (percent) => {
    (self as unknown as Worker).postMessage({ progress: percent });
  }, signal);
  if (flac.byteLength >= source.byteLength) {
    throw new Error("FLAC output is not smaller than the source; no upload was made");
  }
  const expectedHash = String(payload.sourceSha256 || payload.sha256 || "").toLowerCase();
  if (expectedHash && expectedHash !== evidence.sourceSha256) {
    throw new Error("source hash no longer matches the queued snapshot; conversion was discarded");
  }

  (self as unknown as Worker).postMessage({ progress: 99 });
  const upload = await fetch(uploadUrl, {
    method: "POST",
    body: flac,
    signal,
    headers: {
      "Content-Type": "audio/flac",
      "X-Source-SHA256": evidence.sourceSha256,
      "X-Output-SHA256": evidence.outputSha256,
      "X-Source-PCM-SHA256": evidence.sourcePcmSha256,
      "X-Output-PCM-SHA256": evidence.outputPcmSha256,
      "X-Verification-JSON": JSON.stringify({
        ...evidence.format,
        sourceBytes: evidence.sourceBytes,
        outputBytes: evidence.outputBytes,
        metadataPreserved: evidence.metadataPreserved,
      }),
      "X-Work-Attempt": String(payload.attempts || ""),
      "X-Work-Claimed-At": String(payload.claimedAt || ""),
    },
  });
  if (!upload.ok) {
    const body = await upload.text().catch(() => "");
    throw new Error(`verified FLAC upload failed: HTTP ${upload.status} ${body.slice(0, 200)}`);
  }
  const registered = await upload.json() as { ok?: boolean; registered?: boolean; r2Key?: string; size?: number; instanceId?: string };
  if (registered.ok !== true || registered.registered !== true || !registered.r2Key
    || registered.size !== flac.byteLength || registered.instanceId !== instanceId) {
    throw new Error("upload was not registered against the source instance; no success was reported");
  }
  return { ...registered, evidence };
}

async function runScrape(payload: Record<string, unknown>): Promise<unknown> {
  if (payload.kind !== "metadata-retrieval") throw new Error("unsupported scrape task kind");
  const proxyUrl = String(payload.scrapeProxyUrl || "");
  if (!proxyUrl) throw new Error("metadata retrieval task missing scrape proxy URL");
  return runMetadataRetrieval(payload, proxyUrl, activeTaskController?.signal || new AbortController().signal);
}

export {};
