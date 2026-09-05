import { spawn } from "node:child_process";

const port = 8792;
const command = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(command, [
  "wrangler", "dev",
  "--config", "test/internal/pbkdf2_workerd_probe.wrangler.toml",
  "--port", String(port),
  "--ip", "127.0.0.1",
], { stdio: ["ignore", "pipe", "pipe"] });

let output = "";
child.stdout.on("data", (chunk) => { output += String(chunk); });
child.stderr.on("data", (chunk) => { output += String(chunk); });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitForWorker(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch {
      // The workerd process has not accepted requests yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`workerd did not become ready:\n${output}`);
}

async function main() {
  try {
    await waitForWorker();
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const body = await response.json() as {
      stored?: string;
      verified?: { valid?: boolean; legacy?: boolean };
      rejected?: { valid?: boolean; legacy?: boolean };
    };
    assert(response.status === 200, `workerd returned ${response.status}`);
    assert(body.stored?.startsWith("pbkdf2-sha256$210000$"), "workerd preserved the PBKDF2 storage format");
    assert(body.verified?.valid === true && body.verified.legacy === false, "workerd verified the generated PBKDF2 password");
    assert(body.rejected?.valid === false && body.rejected.legacy === false, "workerd rejected a wrong PBKDF2 password");
    console.log("workerd PBKDF2 regression: PASS");
  } finally {
    child.kill("SIGINT");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
