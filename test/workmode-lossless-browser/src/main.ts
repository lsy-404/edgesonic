import { runTask, type QueuedTask } from "../../../web/src/lib/taskRunner";

const status = document.querySelector<HTMLElement>("#status")!;
const fixtureView = document.querySelector<HTMLElement>("#fixture")!;
const resultView = document.querySelector<HTMLElement>("#result")!;
const download = document.querySelector<HTMLAnchorElement>("#download")!;
const start = document.querySelector<HTMLButtonElement>("#start")!;
const realStart = document.querySelector<HTMLButtonElement>("#real-start")!;

async function showFixture() {
  const response = await fetch("/fixture/report");
  const report = await response.json();
  fixtureView.textContent = JSON.stringify(report.fixture, null, 2);
}

start.addEventListener("click", async () => {
  start.disabled = true;
  download.hidden = true;
  resultView.textContent = "";
  status.textContent = "Fetching the generated source snapshot…";
  const sourceResponse = await fetch("/fixture/source");
  const sourceBytes = await sourceResponse.arrayBuffer();
  const sourceHash = await crypto.subtle.digest("SHA-256", sourceBytes);
  const sourceSha256 = Array.from(new Uint8Array(sourceHash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const task: QueuedTask = {
    id: "fixture-lossless-task",
    taskType: "lossless",
    payload: {
      instanceId: "fixture-source-instance",
      sourceUri: "/fixture/source",
      streamUrl: new URL("/fixture/source", location.origin).toString(),
      sourceSize: sourceBytes.byteLength,
      sourceSha256,
      uploadUrl: new URL("/fixture/upload", location.origin).toString(),
    },
    requiredCaps: ["lossless"],
    priority: 0,
    attempts: 2,
    maxAttempts: 3,
    claimedAt: 1_800_000_000,
    heartbeatAt: 1_800_000_000,
  };

  try {
    status.textContent = "Running the real task runner and browser worker…";
    const outcome = await runTask(task, {
      restUrl: () => "/fixture/source",
      edgesonicPost: async (path, body, signal) => {
        const route = path === "work/heartbeat" ? "/fixture/work/heartbeat" : "/fixture/work/submit";
        const response = await fetch(route, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) throw new Error(`Local task endpoint returned HTTP ${response.status}`);
        return response.text();
      },
    }, new AbortController().signal);
    const reportResponse = await fetch("/fixture/report");
    const report = await reportResponse.json();
    resultView.textContent = JSON.stringify({ outcome, ...report }, null, 2);
    if (outcome.status === "ok" && report.upload?.verified === true && report.submission?.accepted === true) {
      status.textContent = "PASS: conversion, metadata and PCM verification, local upload, and task submission succeeded.";
      download.href = "/fixture/output";
      download.hidden = false;
      download.textContent = "Download locally uploaded FLAC";
    } else {
      status.textContent = `FAILED: ${outcome.status === "failed" ? outcome.error : "fixture was canceled or upload evidence was incomplete"}`;
    }
  } catch (error) {
    status.textContent = `FAILED: ${error instanceof Error ? error.message : String(error)}`;
    resultView.textContent = String(error);
  } finally {
    start.disabled = false;
  }
});

realStart.addEventListener("click", async () => {
  const runtime = new URL("/runtime", location.origin).toString().replace(/\/$/u, "");
  const proxyUrl = (value: unknown) => {
    const url = new URL(String(value));
    return `${runtime}${url.pathname}${url.search}`;
  };
  realStart.disabled = true;
  start.disabled = true;
  download.hidden = true;
  resultView.textContent = "";
  status.textContent = "Seeding the generated WAV into the local D1/R2 test runtime…";
  try {
    const sourceResponse = await fetch("/fixture/source");
    if (!sourceResponse.ok) throw new Error(`Generated source returned HTTP ${sourceResponse.status}`);
    const sourceBytes = await sourceResponse.arrayBuffer();
    const init = await fetch(`${runtime}/__fixture/init`, { method: "POST" });
    if (!init.ok) throw new Error(`Local runtime initialization returned HTTP ${init.status}`);
    const seeded = await fetch(`${runtime}/__fixture/seed`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: sourceBytes,
    });
    if (!seeded.ok) throw new Error(`Local runtime seed returned HTTP ${seeded.status}: ${await seeded.text()}`);
    const claim = await seeded.json() as Record<string, unknown>;
    const id = String(claim.id || "");
    const attempts = Number(claim.attempts);
    const claimedAt = Number(claim.claimedAt);
    if (!id || !String(claim.streamUrl || "") || !String(claim.uploadUrl || "")
      || !String(claim.submitUrl || "") || !String(claim.heartbeatUrl || "")) {
      throw new Error("Local runtime seed did not return a complete signed lossless claim.");
    }
    const task: QueuedTask = {
      id,
      taskType: "lossless",
      payload: {
        ...claim,
        streamUrl: proxyUrl(claim.streamUrl),
        uploadUrl: proxyUrl(claim.uploadUrl),
        sourceSize: Number(claim.sourceSize),
      },
      requiredCaps: ["lossless"],
      priority: 0,
      attempts,
      maxAttempts: Number(claim.maxAttempts || 3),
      claimedAt,
      heartbeatAt: claimedAt,
    };
    status.textContent = "Running the real browser worker against the local D1/R2 source and upload routes…";
    const outcome = await runTask(task, {
      restUrl: () => "",
      edgesonicPost: async (path, body, signal) => {
        const endpoint = path === "work/heartbeat" ? proxyUrl(claim.heartbeatUrl) : proxyUrl(claim.submitUrl);
        const response = await fetch(String(endpoint), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`Local runtime ${path} returned HTTP ${response.status}: ${text}`);
        return text;
      },
    }, new AbortController().signal);
    const readback = await fetch(`${runtime}/__fixture/state?id=${encodeURIComponent(id)}`);
    const state = readback.ok ? await readback.json() : { error: `Readback HTTP ${readback.status}`, body: await readback.text() };
    resultView.textContent = JSON.stringify({ claim, outcome, state }, null, 2);
    status.textContent = outcome.status === "ok"
      ? "Real local D1/R2 path completed; inspect the task, instance, entry and R2 catalog readback below."
      : `FAILED: ${outcome.status === "failed" ? outcome.error : outcome.status}`;
  } catch (error) {
    status.textContent = `FAILED: ${error instanceof Error ? error.message : String(error)}`;
    resultView.textContent = String(error);
  } finally {
    realStart.disabled = false;
    start.disabled = false;
  }
});

void showFixture().catch((error) => {
  fixtureView.textContent = String(error);
});
