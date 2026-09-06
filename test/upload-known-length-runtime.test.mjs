import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = new URL("../", import.meta.url);
const port = 8797;
const state = fileURLToPath(new URL(".tmp-upload-known-length-runtime", import.meta.url));
rmSync(state, { recursive: true, force: true });
const child = spawn("npx", [
  "--no-install", "wrangler", "dev",
  "--config", "test/upload-known-length-runtime/wrangler.toml",
  "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", state,
], { cwd: fileURLToPath(root), stdio: ["ignore", "pipe", "pipe"] });

let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });

async function waitForWorker() {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/storage/files/upload?source=r2&name=ready.mp3`, { method: "POST", body: new Uint8Array() });
      if (response.status === 200) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Worker did not start:\n${output}`);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`✓ ${message}`);
}

try {
  await waitForWorker();

  const bytes = new Uint8Array([1, 2, 3, 4]);
  const success = await fetch(`http://127.0.0.1:${port}/storage/files/upload?source=r2&name=success.mp3`, { method: "POST", body: bytes });
  check(success.status === 200, `known-length R2 upload returns 200 (got ${success.status})`);
  const stored = await fetch(`http://127.0.0.1:${port}/__head`);
  check((await stored.json()).size === bytes.byteLength, "R2 stored every uploaded byte");

  const mismatch = await fetch(`http://127.0.0.1:${port}/__mismatch`);
  const mismatchBody = await mismatch.json();
  check(mismatch.status === 400, `mismatched fixed length returns 400 (got ${mismatch.status}, ${JSON.stringify(mismatchBody)})`);

  const seed = await fetch(`http://127.0.0.1:${port}/storage/files/upload?source=r2&name=conflict.mp3`, { method: "POST", body: bytes });
  check(seed.status === 200, `seed upload returns 200 (got ${seed.status})`);
  const conflict = await fetch(`http://127.0.0.1:${port}/storage/files/upload?source=r2&name=conflict.mp3`, { method: "POST", body: bytes });
  check(conflict.status === 409, `R2 conditional collision returns 409 without a stream rejection (got ${conflict.status})`);

  const unknown = await fetch(`http://127.0.0.1:${port}/storage/files/upload?source=r2&name=unknown.mp3`, {
    method: "POST",
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    duplex: "half",
  });
  check(unknown.status === 411, `missing Content-Length returns 411 (got ${unknown.status})`);
  await delay(100);
  check(!/unhandled|unhandledrejection/i.test(output), "stream rejection handling leaves no unhandled runtime error");
} finally {
  child.kill("SIGTERM");
  rmSync(state, { recursive: true, force: true });
}
