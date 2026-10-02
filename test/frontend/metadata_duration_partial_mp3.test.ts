import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBuffer } from "music-metadata";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

const dir = mkdtempSync(join(tmpdir(), "edgesonic-metadata-duration-"));
const fixture = join(dir, "partial-duration.mp3");
const wavFixture = join(dir, "short-tail.wav");
const flacFixture = join(dir, "bit-depth.flac");
const mp4Fixture = join(dir, "duration-only.mp4");

async function main() {
try {
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "anoisesrc=color=white:sample_rate=44100:duration=152.14",
    "-ac", "2", "-c:a", "libmp3lame", "-b:a", "256k", "-write_xing", "0", fixture, "-y",
  ]);
  const bytes = new Uint8Array(readFileSync(fixture));
  const headBytes = 2 * 1024 * 1024;
  const full = await parseBuffer(bytes, { path: fixture }, { duration: true });
  const partial = await parseBuffer(bytes.subarray(0, headBytes), {
    path: fixture, size: bytes.length,
  }, { duration: true });

  console.log("A. Real music-metadata partial MP3 reproduction:");
  assert(bytes.length > headBytes, "fixture exceeds the 2 MiB Range window");
  assert(Math.round(full.format.duration ?? 0) === 152, "complete buffer reports 152 seconds");
  assert(Math.round(partial.format.duration ?? 0) < 100,
    "2 MiB partial buffer reports a false short duration despite the true size");

  (globalThis as unknown as { self: { addEventListener: () => void } }).self = { addEventListener: () => {} };
  const { runMetadata } = await import("../../web/src/workers/taskExecutor");
  const originalFetch = globalThis.fetch;
  try {
    let fullRequests = 0;
    globalThis.fetch = async (_input, init) => {
      if (new Headers(init?.headers).get("Range")) {
        return new Response(bytes.subarray(0, headBytes), {
          status: 206,
          headers: { "Content-Range": `bytes 0-${headBytes - 1}/${bytes.length}`, "Content-Type": "audio/mpeg" },
        });
      }
      fullRequests++;
      return new Response(bytes, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
    };
    const result = await runMetadata({ instanceId: "instance-full", sourceUri: "r2://music/test.mp3", streamUrl: "https://test/stream", suffix: "mp3", size: bytes.length }) as { tags: Record<string, unknown> };
    console.log("\nB. Metadata executor uses a full MP3 read for duration:");
    assert(fullRequests === 1, "made exactly one un-ranged full-object request");
    assert(result.tags.duration === 152, "submits the complete 152-second duration, not the partial estimate");

    globalThis.fetch = async (_input, init) => {
      if (new Headers(init?.headers).get("Range")) {
        return new Response(bytes.subarray(0, headBytes), {
          status: 206,
          headers: { "Content-Range": `bytes 0-${headBytes - 1}/${bytes.length}`, "Content-Type": "audio/mpeg" },
        });
      }
      throw new Error("full object unavailable");
    };
    const unavailable = await runMetadata({ instanceId: "instance-unavailable", sourceUri: "r2://music/test.mp3", streamUrl: "https://test/stream", suffix: "mp3", size: bytes.length }) as { tags: Record<string, unknown> };
    console.log("\nC. A failed full read preserves stored duration:");
    assert(!Object.hasOwn(unavailable.tags, "duration"), "omits duration instead of submitting a partial estimate");

    globalThis.fetch = async (_input, init) => {
      if (new Headers(init?.headers).get("Range")) {
        return new Response(bytes.subarray(0, headBytes), {
          status: 206,
          headers: { "Content-Range": `bytes 0-${headBytes - 1}/${bytes.length}`, "Content-Type": "audio/mpeg" },
        });
      }
      return new Response(bytes.subarray(0, headBytes), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
    };
    const truncated = await runMetadata({ instanceId: "instance-truncated", sourceUri: "r2://music/test.mp3", streamUrl: "https://test/stream", suffix: "mp3", size: bytes.length }) as { tags: Record<string, unknown> };
    assert(!Object.hasOwn(truncated.tags, "duration"), "rejects a short 200 response as a duration source");

    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=44100:duration=20",
      "-ac", "2", "-c:a", "pcm_s16le", "-metadata", "title=Range fixture", wavFixture, "-y",
    ]);
    const wavBytes = new Uint8Array(readFileSync(wavFixture));
    let tailRequests = 0;
    let wavFullRequests = 0;
    globalThis.fetch = async (_input, init) => {
      const range = new Headers(init?.headers).get("Range");
      if (range === `bytes=0-${headBytes - 1}`) {
        return new Response(wavBytes.subarray(0, headBytes), {
          status: 206,
          headers: { "Content-Range": `bytes 0-${headBytes - 1}/${wavBytes.length}`, "Content-Type": "audio/wav" },
        });
      }
      if (range === `bytes=${headBytes}-${wavBytes.length - 1}`) {
        tailRequests++;
        return new Response(wavBytes.subarray(headBytes), {
          status: 206,
          headers: { "Content-Range": `bytes ${headBytes}-${wavBytes.length - 1}/${wavBytes.length}`, "Content-Type": "audio/wav" },
        });
      }
      wavFullRequests++;
      return new Response(wavBytes, { status: 200, headers: { "Content-Type": "audio/wav" } });
    };
    const wav = await runMetadata({ instanceId: "instance-wav", sourceUri: "r2://music/test.wav", streamUrl: "https://test/stream", suffix: "wav", size: wavBytes.length }) as { tags: Record<string, unknown> };
    console.log("\nD. Short WAV tail completes the partial Range response:");
    assert(wavBytes.length > headBytes && wavBytes.length < headBytes + 2 * 1024 * 1024,
      "fixture has a remaining tail smaller than the tail window");
    assert(tailRequests === 1, "requests the complete remaining WAV tail");
    assert(wavFullRequests === 0, "does not rely on the metadata-empty full-file fallback");
    assert(wav.tags.duration === 20, "submits the complete 20-second WAV duration");
    assert(wav.tags.title === "Range fixture", "preserves tags from a WAV whose data and trailing metadata fit the requested ranges");
    assert(wav.tags.bitDepth === 16, "includes the parsed PCM WAV bit depth in the metadata wire result");

    const sampleCount = 36_462_468;
    const dataSize = sampleCount * 4;
    const virtualFileSize = 76 + dataSize;
    const largeWavHead = new Uint8Array(headBytes);
    largeWavHead.set(new TextEncoder().encode("RIFF"), 0);
    new DataView(largeWavHead.buffer).setUint32(4, virtualFileSize - 8, true);
    largeWavHead.set(new TextEncoder().encode("WAVEfmt "), 8);
    const largeView = new DataView(largeWavHead.buffer);
    largeView.setUint32(16, 16, true);
    largeView.setUint16(20, 1, true);
    largeView.setUint16(22, 2, true);
    largeView.setUint32(24, 44_100, true);
    largeView.setUint32(28, 176_400, true);
    largeView.setUint16(32, 4, true);
    largeView.setUint16(34, 16, true);
    largeWavHead.set(new TextEncoder().encode("LIST"), 36);
    largeView.setUint32(40, 24, true);
    largeWavHead.set(new TextEncoder().encode("INFOINAM"), 44);
    largeView.setUint32(52, 12, true);
    largeWavHead.set(new TextEncoder().encode("range title\0"), 56);
    largeWavHead.set(new TextEncoder().encode("data"), 68);
    largeView.setUint32(72, dataSize, true);
    const clampedLargeWav = await parseBuffer(largeWavHead, { path: "large.wav" }, { duration: true });
    let largeTailRequests = 0;
    let largeUnrangedRequests = 0;
    globalThis.fetch = async (_input, init) => {
      const range = new Headers(init?.headers).get("Range");
      if (range === `bytes=0-${headBytes - 1}`) {
        return new Response(largeWavHead, {
          status: 206,
          headers: { "Content-Range": `bytes 0-${headBytes - 1}/${virtualFileSize}`, "Content-Type": "audio/wav" },
        });
      }
      if (range === `bytes=${virtualFileSize - 2 * 1024 * 1024}-${virtualFileSize - 1}`) {
        largeTailRequests++;
        return new Response(new Uint8Array(2 * 1024 * 1024), {
          status: 206,
          headers: { "Content-Range": `bytes ${virtualFileSize - 2 * 1024 * 1024}-${virtualFileSize - 1}/${virtualFileSize}`, "Content-Type": "audio/wav" },
        });
      }
      largeUnrangedRequests++;
      throw new Error("large WAV must not be fetched in full");
    };
    const largeWav = await runMetadata({ instanceId: "instance-large-wav", sourceUri: "r2://music/large.wav", streamUrl: "https://test/stream", suffix: "wav", size: virtualFileSize }) as { tags: Record<string, unknown> };
    console.log("\nE. Large WAV declared PCM duration uses validated RIFF frame count:");
    assert(virtualFileSize > 145_000_000, "simulated object is over 145 MB while only two ranges are materialized");
    assert(Math.round(clampedLargeWav.format.duration ?? 0) === 12, "music-metadata alone clamps the 145 MB RIFF data length to its 2 MiB input buffer");
    assert(largeTailRequests === 1 && largeUnrangedRequests === 0, "reads only head and tail ranges, never the full 145 MiB object");
    assert(largeWav.tags.duration === 827, "uses declared PCM frame count (826.81 seconds), not the 2 MiB buffer clamp");
    assert(largeWav.tags.bitrate === 1411, "reports the validated PCM byte rate");
    assert(largeWav.tags.bitDepth === 16, "includes bit depth for a partial PCM WAV");

    const invalidWavHead = largeWavHead.slice();
    new DataView(invalidWavHead.buffer).setUint32(72, dataSize + 4, true);
    globalThis.fetch = async (_input, init) => {
      if (new Headers(init?.headers).get("Range") === `bytes=0-${headBytes - 1}`) {
        return new Response(invalidWavHead, {
          status: 206,
          headers: { "Content-Range": `bytes 0-${headBytes - 1}/${virtualFileSize}`, "Content-Type": "audio/wav" },
        });
      }
      return new Response(new Uint8Array(2 * 1024 * 1024), { status: 206, headers: { "Content-Type": "audio/wav" } });
    };
    const invalidWav = await runMetadata({ instanceId: "instance-invalid-wav", sourceUri: "r2://music/invalid.wav", streamUrl: "https://test/stream", suffix: "wav", size: virtualFileSize }) as { tags: Record<string, unknown> };
    assert(!Object.hasOwn(invalidWav.tags, "duration"), "omits duration when declared data exceeds the RIFF/file boundary");
    assert(invalidWav.tags.bitrate === 0, "does not retain a bitrate from an invalid partial WAV header");

    async function parsePartialWavHeader(head: Uint8Array, id: string) {
      globalThis.fetch = async (_input, init) => {
        if (new Headers(init?.headers).get("Range") === `bytes=0-${headBytes - 1}`) {
          return new Response(head, {
            status: 206,
            headers: { "Content-Range": `bytes 0-${headBytes - 1}/${virtualFileSize}`, "Content-Type": "audio/wav" },
          });
        }
        return new Response(new Uint8Array(2 * 1024 * 1024), { status: 206, headers: { "Content-Type": "audio/wav" } });
      };
      return await runMetadata({ instanceId: id, sourceUri: `r2://music/${id}.wav`, streamUrl: "https://test/stream", suffix: "wav", size: virtualFileSize }) as { tags: Record<string, unknown> };
    }

    const invalidChannelsHead = largeWavHead.slice();
    const invalidChannelsView = new DataView(invalidChannelsHead.buffer);
    invalidChannelsView.setUint16(22, 0, true);
    invalidChannelsView.setUint32(28, 0, true);
    invalidChannelsView.setUint16(32, 0, true);
    const invalidChannels = await parsePartialWavHeader(invalidChannelsHead, "invalid-channels");
    assert(!Object.hasOwn(invalidChannels.tags, "duration"), "rejects zero channels even when byte rate matches zero alignment");

    const invalidBitsHead = largeWavHead.slice();
    const invalidBitsView = new DataView(invalidBitsHead.buffer);
    invalidBitsView.setUint32(28, 132_300, true);
    invalidBitsView.setUint16(32, 3, true);
    invalidBitsView.setUint16(34, 12, true);
    const invalidBits = await parsePartialWavHeader(invalidBitsHead, "invalid-bits");
    assert(!Object.hasOwn(invalidBits.tags, "duration"), "rejects unsupported 12-bit PCM despite a self-consistent byte rate and block alignment");

    const emptyDataHead = largeWavHead.slice();
    new DataView(emptyDataHead.buffer).setUint32(72, 0, true);
    const emptyData = await parsePartialWavHeader(emptyDataHead, "empty-data");
    assert(!Object.hasOwn(emptyData.tags, "duration"), "rejects a zero-length data chunk");

    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=2",
      "-c:a", "flac", "-sample_fmt", "s16", flacFixture, "-y",
    ]);
    const flacBytes = new Uint8Array(readFileSync(flacFixture));
    globalThis.fetch = async () => new Response(flacBytes, { status: 200, headers: { "Content-Type": "audio/flac" } });
    const flac = await runMetadata({ instanceId: "instance-flac-depth", sourceUri: "r2://music/bit-depth.flac", streamUrl: "https://test/stream", suffix: "flac", size: flacBytes.length }) as { tags: Record<string, unknown> };
    assert(flac.tags.bitDepth === 16, "includes music-metadata FLAC bitsPerSample in the metadata wire result");

    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=12",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=12",
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "4000k",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", mp4Fixture, "-y",
    ]);
    const mp4Bytes = new Uint8Array(readFileSync(mp4Fixture));
    let mp4FullRequests = 0;
    globalThis.fetch = async (_input, init) => {
      if (new Headers(init?.headers).get("Range")) {
        return new Response(mp4Bytes.subarray(0, headBytes), {
          status: 206,
          headers: { "Content-Range": `bytes 0-${headBytes - 1}/${mp4Bytes.length}`, "Content-Type": "audio/mpeg" },
        });
      }
      mp4FullRequests++;
      return new Response(mp4Bytes, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
    };
    const mp4 = await runMetadata({ instanceId: "instance-mp4", sourceUri: "r2://music/test.mp4", streamUrl: "https://test/stream", suffix: "mp4", size: mp4Bytes.length }) as { tags: Record<string, unknown> };
    assert(mp4Bytes.length > headBytes, "MP4 fixture exceeds the metadata Range window");
    assert(mp4FullRequests === 1, "reads the complete MP4 when the head slice has no duration");
    assert(mp4.tags.duration === 12, "keeps duration from a full MP4 parse even without text tags");

    mp4FullRequests = 0;
    const mislabeledMp4 = await runMetadata({ instanceId: "instance-mp3-container", sourceUri: "r2://music/upload.mp3", streamUrl: "https://test/stream", suffix: "mp3", size: mp4Bytes.length }) as { tags: Record<string, unknown> };
    assert(mp4FullRequests === 1, "uses the required full read for a mislabeled MPEG-4 audio path");
    assert(mislabeledMp4.tags.duration === 12, "uses the MPEG-4 container signature when the source MIME is audio/mpeg");
  } finally {
    globalThis.fetch = originalFetch;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
if (failures > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
