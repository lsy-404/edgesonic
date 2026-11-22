// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const SUBSCRIPTION = process.env.MEDIA_PROXY_SUBSCRIPTION || "";
const LISTEN_PORT = 10809;
const PROXY_URL = `http://127.0.0.1:${LISTEN_PORT}`;
const CONFIG_DIR = path.join(os.tmpdir(), "edgesonic-proxy");
const REFRESH_MS = 60 * 60 * 1000;
const PROXIED_SUFFIXES = ["bilibili.com", "bilibili.tv", "b23.tv", "bilivideo.com", "bilivideo.cn", "biliapi.net", "hdslb.com", "akamaized.net"];

let child = null;
let ready = null;
let dispatcher = null;
let configText = "";

export const proxyConfigured = Boolean(SUBSCRIPTION);

export function proxiedHost(hostname) {
  const host = hostname.toLowerCase();
  return proxyConfigured && PROXIED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function outbound(uri, index) {
  const url = new URL(uri);
  if (url.protocol !== "vless:") return null;
  const query = url.searchParams;
  const address = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port);
  const id = decodeURIComponent(url.username);
  if (!address || !Number.isInteger(port) || !id) return null;
  const user = { id, encryption: "none", ...(query.get("flow") ? { flow: query.get("flow") } : {}) };
  const streamSettings = { network: query.get("type") || "tcp", security: query.get("security") || "none" };
  if (streamSettings.security === "tls") {
    streamSettings.tlsSettings = { serverName: query.get("sni") || address, fingerprint: query.get("fp") || "chrome", ...(query.get("alpn") ? { alpn: query.get("alpn").split(",") } : {}) };
  } else if (streamSettings.security === "reality") {
    streamSettings.realitySettings = { serverName: query.get("sni") || "", fingerprint: query.get("fp") || "chrome", publicKey: query.get("pbk") || "", shortId: query.get("sid") || "" };
  } else return null;
  if (streamSettings.network === "xhttp") {
    streamSettings.xhttpSettings = { host: query.get("host") || "", path: query.get("path") || "/", mode: query.get("mode") || "auto" };
  } else if (streamSettings.network !== "tcp") return null;
  return { tag: `node-${index}`, protocol: "vless", settings: { vnext: [{ address, port, users: [user] }] }, streamSettings };
}

async function buildConfig() {
  const target = new URL(SUBSCRIPTION);
  target.searchParams.set("format", "uri");
  const response = await fetch(target, { headers: { Accept: "text/plain" }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`proxy subscription returned HTTP ${response.status}`);
  const outbounds = (await response.text()).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((line, index) => { try { return outbound(line, index); } catch { return null; } }).filter(Boolean);
  if (!outbounds.length) throw new Error("proxy subscription has no usable routes");
  return JSON.stringify({
    log: { loglevel: "warning" },
    inbounds: [{ tag: "http-in", listen: "127.0.0.1", port: LISTEN_PORT, protocol: "http" }],
    outbounds: [...outbounds, { tag: "block", protocol: "blackhole" }],
    observatory: { subjectSelector: ["node-"], probeUrl: "https://www.gstatic.com/generate_204", probeInterval: "5m", enableConcurrency: true },
    routing: {
      balancers: [{ tag: "exit", selector: ["node-"], strategy: { type: "leastPing" } }],
      rules: [{ type: "field", inboundTag: ["http-in"], balancerTag: "exit" }],
    },
  });
}

function waitForPort(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect(LISTEN_PORT, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error("proxy did not start"));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

async function start() {
  const next = await buildConfig();
  if (child && next === configText) return;
  configText = next;
  await mkdir(CONFIG_DIR, { recursive: true });
  const file = path.join(CONFIG_DIR, "config.json");
  await writeFile(file, next, { mode: 0o600 });
  if (child) { child.removeAllListeners("exit"); child.kill("SIGTERM"); child = null; }
  const process_ = spawn("xray", ["run", "-config", file], { stdio: ["ignore", "ignore", "inherit"] });
  child = process_;
  process_.once("exit", (code) => {
    if (child !== process_) return;
    console.error("media proxy exited", code);
    child = null;
    ready = null;
    setTimeout(() => ensureProxy().catch((error) => console.error("media proxy restart failed", error.message)), 2000).unref();
  });
  await waitForPort(10000);
}

export async function ensureProxy() {
  if (!proxyConfigured) return null;
  if (!ready) {
    ready = start().catch((error) => { ready = null; throw error; });
  }
  await ready;
  return PROXY_URL;
}

export async function proxyFor(url) {
  return proxiedHost(new URL(url).hostname) ? ensureProxy() : null;
}

export async function proxiedFetch(input, init = {}) {
  if (!(await proxyFor(String(input)))) return fetch(input, init);
  dispatcher ??= new ProxyAgent(PROXY_URL);
  return undiciFetch(input, { ...init, dispatcher });
}

if (proxyConfigured) {
  ensureProxy().catch((error) => console.error("media proxy unavailable", error.message));
  setInterval(() => {
    if (!child) return;
    ready = start().catch((error) => { console.error("media proxy refresh failed", error.message); });
  }, REFRESH_MS).unref();
}
