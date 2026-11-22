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
const PROBE_PORT_BASE = 20000;
// Bilibili answers HTTP 412 to data-center exits, so only routes that pass this request are used.
const PROBE_URL = "https://www.bilibili.com/video/BV1xx411c7mD";
const PROXIED_SUFFIXES = ["bilibili.com", "bilibili.tv", "b23.tv", "bilivideo.com", "bilivideo.cn", "biliapi.net", "hdslb.com", "akamaized.net"];

let child = null;
let ready = null;
let dispatcher = null;
let configText = "";
let usableTags = null;

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
  if (!address || !Number.isInteger(port) || port < 1 || port > 65535 || !id) return null;
  const user = { id, encryption: query.get("encryption") || "none", ...(query.get("flow") ? { flow: query.get("flow") } : {}) };
  const streamSettings = { network: query.get("type") || "tcp", security: query.get("security") || "none" };
  if (streamSettings.security === "tls") {
    streamSettings.tlsSettings = { serverName: query.get("sni") || address, fingerprint: query.get("fp") || "chrome", ...(query.get("alpn") ? { alpn: query.get("alpn").split(",") } : {}) };
  } else if (streamSettings.security === "reality") {
    streamSettings.realitySettings = { serverName: query.get("sni") || "", fingerprint: query.get("fp") || "chrome", publicKey: query.get("pbk") || "", shortId: query.get("sid") || "" };
  } else return null;
  if (streamSettings.network === "xhttp") {
    streamSettings.xhttpSettings = { host: query.get("host") || "", path: query.get("path") || "/", mode: query.get("mode") || "auto" };
  } else if (streamSettings.network !== "tcp") return null;
  return { tag: `node-${index}-`, protocol: "vless", settings: { vnext: [{ address, port, users: [user] }] }, streamSettings };
}

async function fetchRoutes() {
  const target = new URL(SUBSCRIPTION);
  target.searchParams.set("format", "uri");
  const response = await fetch(target, { headers: { Accept: "text/plain" }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`proxy subscription returned HTTP ${response.status}`);
  const outbounds = (await response.text()).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((line, index) => { try { return outbound(line, index); } catch { return null; } }).filter(Boolean);
  if (!outbounds.length) throw new Error("proxy subscription has no usable routes");
  return outbounds;
}

function renderConfig(outbounds, selected) {
  return JSON.stringify({
    log: { loglevel: "warning" },
    inbounds: [
      { tag: "http-in", listen: "127.0.0.1", port: LISTEN_PORT, protocol: "http" },
      ...outbounds.map((route, index) => ({ tag: `probe-${index}`, listen: "127.0.0.1", port: PROBE_PORT_BASE + index, protocol: "http" })),
    ],
    outbounds: [...outbounds, { tag: "block", protocol: "blackhole" }],
    observatory: { subjectSelector: selected, probeUrl: "https://www.gstatic.com/generate_204", probeInterval: "5m", enableConcurrency: true },
    routing: {
      balancers: [{ tag: "exit", selector: selected, strategy: { type: "leastPing" } }],
      rules: [
        ...outbounds.map((route, index) => ({ type: "field", inboundTag: [`probe-${index}`], outboundTag: route.tag })),
        { type: "field", inboundTag: ["http-in"], balancerTag: "exit" },
      ],
    },
  });
}

async function probeRoutes(outbounds) {
  const results = await Promise.all(outbounds.map(async (route, index) => {
    const agent = new ProxyAgent(`http://127.0.0.1:${PROBE_PORT_BASE + index}`);
    try {
      const response = await undiciFetch(PROBE_URL, { dispatcher: agent, redirect: "manual", headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" }, signal: AbortSignal.timeout(20000) });
      await response.body?.cancel();
      return response.status < 400 || response.status === 404 ? route.tag : null;
    } catch {
      return null;
    } finally {
      await agent.close().catch(() => {});
    }
  }));
  return results.filter(Boolean);
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

function stopChild() {
  const current = child;
  child = null;
  configText = "";
  if (!current || current.exitCode !== null || current.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    current.removeAllListeners("exit");
    current.once("exit", () => resolve());
    current.kill("SIGTERM");
    setTimeout(() => current.kill("SIGKILL"), 5000).unref();
  });
}

async function launch(next) {
  if (child && next === configText) return waitForPort(10000);
  await stopChild();
  await mkdir(CONFIG_DIR, { recursive: true });
  const file = path.join(CONFIG_DIR, "config.json");
  await writeFile(file, next, { mode: 0o600 });
  const process_ = spawn("xray", ["run", "-config", file], { stdio: ["ignore", "ignore", "inherit"] });
  child = process_;
  configText = next;
  const exited = new Promise((_, reject) => {
    process_.once("error", (error) => reject(new Error(`proxy failed to launch: ${error.code || error.message}`)));
    process_.once("exit", (code) => reject(new Error(`proxy exited with code ${code}`)));
  });
  exited.catch(() => {
    if (child !== process_) return;
    console.error("media proxy stopped");
    child = null;
    configText = "";
    ready = null;
    setTimeout(() => ensureProxy().catch((error) => console.error("media proxy restart failed", error.message)), 2000).unref();
  });
  try {
    await Promise.race([waitForPort(10000), exited]);
  } catch (error) {
    if (child === process_) await stopChild();
    throw error;
  }
}

async function start() {
  const outbounds = await fetchRoutes();
  const all = outbounds.map((route) => route.tag);
  const previous = usableTags?.filter((tag) => all.includes(tag));
  await launch(renderConfig(outbounds, previous?.length ? previous : all));
  const usable = await probeRoutes(outbounds);
  if (!usable.length) console.error("media proxy: no route passed the Bilibili probe");
  usableTags = usable.length ? usable : all;
  await launch(renderConfig(outbounds, usableTags));
}

function track(promise) {
  const current = promise.catch((error) => {
    if (ready === current) ready = null;
    throw new Error(error.message.startsWith("proxy ") ? error.message : `proxy ${error.message}`);
  });
  ready = current;
  return current;
}

export async function ensureProxy() {
  if (!proxyConfigured) return null;
  await (ready || track(start()));
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
    const previous = ready;
    if (!child || !previous) return;
    const refreshed = previous.catch(() => {}).then(start).catch((error) => {
      console.error("media proxy refresh failed", error.message);
      if (child) return;
      if (ready === refreshed) ready = null;
      throw error;
    });
    ready = refreshed;
    refreshed.catch(() => {});
  }, REFRESH_MS).unref();
}
