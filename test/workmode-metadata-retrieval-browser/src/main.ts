import { runTask, type QueuedTask } from "../../../web/src/lib/taskRunner";

const start = document.querySelector<HTMLButtonElement>("#start")!;
const status = document.querySelector<HTMLElement>("#status")!;
const reportView = document.querySelector<HTMLElement>("#report")!;

async function refreshReport() {
  const response = await fetch("/fixture/report");
  reportView.textContent = JSON.stringify(await response.json(), null, 2);
}

start.addEventListener("click", async () => {
  start.disabled = true;
  reportView.textContent = "";
  status.textContent = "Running the real task runner and browser worker against local provider fixtures…";
  try {
    await fetch("/fixture/reset", { method: "POST" });
    const task: QueuedTask = {
      id: "fixture-metadata-task",
      taskType: "scrape",
      payload: {
        kind: "metadata-retrieval",
        masterId: "fixture-master",
        instanceId: "fixture-instance",
        sourceUri: "r2://fixture/fixture-source.mp3",
        sourceEtag: "fixture-etag",
        identity: { title: "Fixture Song", artist: "Fixture Artist", album: "Fixture Album" },
        snapshot: { title: "Fixture Song", artist: "Fixture Artist", coverR2Key: null },
        sources: ["netease"],
        query: "Fixture Song Fixture Artist Fixture Album",
      },
      requiredCaps: ["metadata-retrieval"],
      priority: 0,
      attempts: 1,
      maxAttempts: 3,
      claimedAt: Math.floor(Date.now() / 1000),
      heartbeatAt: Math.floor(Date.now() / 1000),
    };
    const outcome = await runTask(task, {
      restUrl: (path) => `/rest/${path}`,
      edgesonicPost: async (path, body, signal) => {
        const endpoint = path === "work/heartbeat" ? "/fixture/work/heartbeat" : "/fixture/work/submit";
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) throw new Error(`Fixture task endpoint returned HTTP ${response.status}`);
        return response.text();
      },
    }, new AbortController().signal);
    await refreshReport();
    const report = JSON.parse(reportView.textContent || "{}");
    if (outcome.status === "ok" && report.submission?.accepted === true && report.protocol?.complete === true) {
      status.textContent = "PASS: search, detail, lyrics, worker result, and mocked submit receipt completed.";
    } else {
      status.textContent = `FAILED: ${outcome.status === "failed" ? outcome.error : "fixture protocol evidence was incomplete"}`;
    }
  } catch (error) {
    status.textContent = `FAILED: ${error instanceof Error ? error.message : String(error)}`;
    await refreshReport().catch(() => {});
  } finally {
    start.disabled = false;
  }
});

void refreshReport().catch((error) => {
  reportView.textContent = String(error);
});
