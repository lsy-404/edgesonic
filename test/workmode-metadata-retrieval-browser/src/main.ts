import { runTask, type QueuedTask } from "../../../web/src/lib/taskRunner";
import { resolveMetadataRetrievalCandidate } from "../../../web/src/lib/workmodeMetadataRetrieval";

const start = document.querySelector<HTMLButtonElement>("#start")!;
const review = document.querySelector<HTMLButtonElement>("#review")!;
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
    await fetch("/fixture/reset", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const automatic = await fetch("/fixture/automatic", { method: "POST" }).then((response) => response.json());
    if (!automatic.ok || automatic.queued !== 1 || automatic.afterImmediateRepeat !== 1) throw new Error("Automatic dispatch or cadence gate did not preserve one queued task.");
    const queued = await fetch("/fixture/claim", { method: "POST" }).then((response) => response.json()) as { task?: QueuedTask; error?: string };
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
      status.textContent = "PASS: automatic dispatch and cadence gate, real search, detail, lyrics, catalog apply, and SQLite readback completed.";
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

review.addEventListener("click", async () => {
  start.disabled = review.disabled = true;
  status.textContent = "Running parsed-but-incomplete metadata retrieval and an explicit candidate decision…";
  try {
    await fetch("/fixture/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "ambiguous" }) });
    const queued = await fetch("/fixture/dispatch", { method: "POST" }).then((response) => response.json()) as { task: QueuedTask };
    const outcome = await runTask(queued.task, {
      restUrl: (path) => `/rest/${path}`,
      edgesonicPost: async (path, body, signal) => {
        const endpoint = `/fixture/work/${path.endsWith("heartbeat") ? "heartbeat" : "submit"}`;
        const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
        if (!response.ok) throw new Error(`Task endpoint returned HTTP ${response.status}`);
        return response.text();
      },
    }, new AbortController().signal);
    if (outcome.status !== "ok") throw new Error("Pending search task failed.");
    const before = await fetch("/fixture/metadata-status").then((response) => response.json());
    const pending = before.pending?.[0];
    if (before.counts?.pending !== 1 || pending?.result?.status !== "pending" || pending.result.candidates?.length !== 2) {
      throw new Error("Ambiguous candidates were not retained for the user.");
    }
    const beforeCatalog = await fetch("/fixture/report").then((response) => response.json());
    if (beforeCatalog.catalogReadback.album !== "Pending Uploads") throw new Error("The pending result changed the catalog automatically.");
    const result = await resolveMetadataRetrievalCandidate(pending.payload, pending.result.candidates[0], "/tag/scrape", new AbortController().signal);
    const response = await fetch("/fixture/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: pending.taskId, attempts: pending.attempts, decision: "apply", candidateIndex: 0, result }) });
    const decision = await response.json();
    if (!response.ok || !decision.ok) throw new Error(decision.error || "Candidate apply failed.");
    const after = await fetch("/fixture/metadata-status").then((response) => response.json());
    const afterCatalog = await fetch("/fixture/report").then((response) => response.json());
    if (after.counts?.pending !== 0 || after.counts?.incomplete !== 1 || afterCatalog.catalogReadback.album !== "Fixture Album" || !afterCatalog.catalogReadback.lyrics) {
      throw new Error("The selected candidate was not applied, or a partial fill was incorrectly counted as complete.");
    }
    reportView.textContent = JSON.stringify({ before, decision, after, catalogReadback: afterCatalog.catalogReadback }, null, 2);
    status.textContent = "PASS: parsed incomplete song stays eligible; ambiguous results wait for the user; selected details apply; missing cover still counts as incomplete.";
  } catch (error) {
    status.textContent = `FAILED: ${error instanceof Error ? error.message : String(error)}`;
    await refreshReport().catch(() => {});
  } finally {
    start.disabled = review.disabled = false;
  }
});

void refreshReport().catch((error) => {
  reportView.textContent = String(error);
});
