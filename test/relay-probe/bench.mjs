// Drives the relay probe. Agent and requester run in one process so their
// clocks agree and dispatch latency is directly measurable.
//
//   node bench.mjs [baseUrl] [totalBytes] [chunkBytes] [runs]

const BASE = process.argv[2] || "http://127.0.0.1:8787";
const TOTAL = parseInt(process.argv[3] || String(8 * 1024 * 1024), 10);
const CHUNK = parseInt(process.argv[4] || String(64 * 1024), 10);
const RUNS = parseInt(process.argv[5] || "5", 10);
const PIPELINE = 4;
// Emulated one-way delay to the edge. Localhost hides the dominant real-world
// cost of the chunked return path: one network round trip per chunk. An
// established WebSocket pays this once, not per frame.
const RTT = parseInt(process.env.RTT_MS || "0", 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const payload = Buffer.alloc(CHUNK, 0x41);

// Set by whichever agent is connected; the requester reads it to compute
// dispatch latency without threading state through the transports.
let onJob = null;

// --- agents ----------------------------------------------------------------

async function connectWsAgent() {
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/agent/ws`);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    const msg = JSON.parse(ev.data);
    if (msg.type !== "job") return;
    onJob?.(performance.now());
    ws.send(JSON.stringify({ type: "bind", job: msg.job }));
    // The socket is already established: frames stream out without waiting on
    // a per-frame response, so the emulated delay applies once.
    let sent = 0;
    while (sent < msg.bytes) {
      const n = Math.min(msg.chunk, msg.bytes - sent);
      ws.send(n === CHUNK ? payload : payload.subarray(0, n));
      sent += n;
    }
    ws.send(JSON.stringify({ type: "fin", job: msg.job }));
  });
  return ws;
}

async function connectSseAgent() {
  const res = await fetch(`${BASE}/agent/sse`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const msg = JSON.parse(line.slice(6));
        if (msg.type === "job") {
          onJob?.(performance.now());
          void returnBytes(msg);
        }
      }
    }
  })();
  return reader;
}

// Return paths available to an SSE-controlled agent.
async function returnBytes(msg) {
  const count = Math.ceil(msg.bytes / msg.chunk);
  if (msg.ret === "sse1") {
    // One request whose body streams. Browsers need duplex:'half' over HTTP/2,
    // which only Chromium ships today.
    let i = 0;
    const body = new ReadableStream({
      pull(c) {
        if (i >= count) { c.close(); return; }
        const n = Math.min(msg.chunk, msg.bytes - i * msg.chunk);
        c.enqueue(new Uint8Array(payload.buffer, payload.byteOffset, n));
        i++;
      },
    });
    if (RTT) await sleep(RTT);
    await fetch(`${BASE}/pushStream?job=${msg.job}`, {
      method: "POST", body, duplex: "half",
    });
    return;
  }
  const conc = msg.ret === "ssep" ? PIPELINE : 1;
  let next = 0;
  async function worker() {
    for (;;) {
      const seq = next++;
      if (seq >= count) return;
      const n = Math.min(msg.chunk, msg.bytes - seq * msg.chunk);
      if (RTT) await sleep(RTT);
      await fetch(
        `${BASE}/push?job=${msg.job}&seq=${seq}&fin=${seq === count - 1 ? 1 : 0}`,
        { method: "POST", body: payload.subarray(0, n) },
      );
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
}

// --- requester -------------------------------------------------------------

async function pull(mode, ret) {
  let dispatchAt = null;
  const t0 = performance.now();
  onJob = (t) => { dispatchAt ??= t; };
  // A stranded job would otherwise hang until undici's body timeout.
  const res = await fetch(
    `${BASE}/pull?mode=${mode}&ret=${ret}&bytes=${TOTAL}&chunk=${CHUNK}`,
    { signal: AbortSignal.timeout(60_000) },
  );
  if (!res.ok) throw new Error(`pull ${mode}/${ret} → ${res.status}`);
  const reader = res.body.getReader();
  let received = 0;
  let ttfb = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    ttfb ??= performance.now() - t0;
    received += value.byteLength;
  }
  const total = performance.now() - t0;
  onJob = null;
  return {
    dispatch: dispatchAt === null ? NaN : dispatchAt - t0,
    ttfb,
    total,
    received,
    mbps: (received / 1e6) / (total / 1000),
  };
}

// --- harness ---------------------------------------------------------------

function summarise(name, rows) {
  const med = (k) => {
    const v = rows.map((r) => r[k]).filter(Number.isFinite).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : NaN;
  };
  const ok = rows.every((r) => r.received === TOTAL);
  return {
    combination: name,
    "dispatch ms": med("dispatch").toFixed(2),
    "TTFB ms": med("ttfb").toFixed(2),
    "total ms": med("total").toFixed(1),
    "MB/s": med("mbps").toFixed(1),
    intact: ok ? "yes" : "NO",
  };
}

const CASES = [
  ["ws  ctrl + ws frames", "ws", "ws"],
  ["sse ctrl + POST x N", "sse", "sse"],
  ["sse ctrl + POST x N (pipelined)", "sse", "ssep"],
  ["sse ctrl + streaming POST", "sse", "sse1"],
];

const ws = await connectWsAgent();
const sse = await connectSseAgent();
await new Promise((r) => setTimeout(r, 200));
console.log(`payload ${(TOTAL / 1048576).toFixed(0)}MB, chunk ${CHUNK / 1024}KB, ${RUNS} runs\n`);

console.log("agents at start:", await (await fetch(`${BASE}/stats`)).text());

const table = [];
for (const [name, mode, ret] of CASES) {
  const rows = [];
  try {
    for (let i = 0; i < RUNS; i++) rows.push(await pull(mode, ret));
    table.push(summarise(name, rows));
  } catch (e) {
    // One stranded combination must not hide the results of the others.
    table.push({ combination: name, intact: `FAILED: ${e.name}` });
  }
}
console.table(table);

ws.close();
await sse.cancel();
process.exit(0);
