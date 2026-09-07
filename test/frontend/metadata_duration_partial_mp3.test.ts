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
