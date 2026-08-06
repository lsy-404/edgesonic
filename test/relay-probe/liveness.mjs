// Can the coordinator tell a dead agent from an idle one?
//
// Connects one agent of each kind in a child process, kills the child without
// a clean shutdown (what a closed laptop / crashed tab looks like), and asks
// the coordinator what it still believes is connected.

import { spawn } from "node:child_process";

const BASE = process.argv[2] || "http://127.0.0.1:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = async () => (await fetch(`${BASE}/stats`)).json();

const child = spawn(process.execPath, ["-e", `
  const BASE = ${JSON.stringify(BASE)};
  const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/agent/ws");
  ws.addEventListener("open", () => console.log("ws open"));
  fetch(BASE + "/agent/sse").then((r) => {
    console.log("sse open");
    return r.body.getReader().read();
  });
  setInterval(() => {}, 1000);
`], { stdio: ["ignore", "pipe", "inherit"] });

await new Promise((res) => {
  let seen = 0;
  child.stdout.on("data", (d) => {
    process.stdout.write(`  child: ${d}`);
    if (++seen >= 2) res();
  });
});

await sleep(500);
console.log("connected      :", await stats());

// SIGKILL — no close frame, no stream cancel. The TCP connection dies only
// when the OS tears the socket down.
child.kill("SIGKILL");
console.log("child killed (SIGKILL, no clean shutdown)");

for (const wait of [1, 3, 10, 30]) {
  await sleep(wait * 1000 - (wait === 1 ? 0 : [1, 3, 10][[1, 3, 10, 30].indexOf(wait) - 1] * 1000));
  console.log(`after ${String(wait).padStart(2)}s   :`, await stats());
}
process.exit(0);
