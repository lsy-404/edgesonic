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
    const queued = await fetch("/fixture/dispatch", { method: "POST" }).then((response) => response.json()) as { task?: QueuedTask; error?: string };
    if (!queued.task) throw new Error(queued.error || "The real dispatch route did not queue a task.");
    const task = queued.task;
    const outcome = await runTask(task, {
      restUrl: (path) => `/rest/${path}`,
      edgesonicPost: async (path, body, signal) => {
        const endpoint = `/fixture/work/${path.endsWith("heartbeat") ? "heartbeat" : "submit"}`;
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
    if (outcome.status === "ok" && report.submission?.accepted === true && report.complete === true) {
      status.textContent = "PASS: real dispatch, search, detail, lyrics, catalog apply, and SQLite readback completed.";
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
