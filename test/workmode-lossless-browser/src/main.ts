import { runTask, type QueuedTask } from "../../../web/src/lib/taskRunner";

const status = document.querySelector<HTMLElement>("#status")!;
const fixtureView = document.querySelector<HTMLElement>("#fixture")!;
const resultView = document.querySelector<HTMLElement>("#result")!;
const download = document.querySelector<HTMLAnchorElement>("#download")!;
const start = document.querySelector<HTMLButtonElement>("#start")!;

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

void showFixture().catch((error) => {
  fixtureView.textContent = String(error);
});
