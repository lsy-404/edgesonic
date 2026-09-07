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
