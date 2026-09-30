import { recoverPendingUploadMetadata } from "../../worker/src/utils/uploadMetadataRecovery";

declare global { type Env = unknown; type D1Database = unknown; }

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

function makeEnv(taskStatus: string, taskPayload: string, opts: { marker?: boolean; recoverTerminalTask?: boolean } = {}) {
  const createdAt = Math.floor(Date.now() / 1000) - 3600;
  const nonce = "new-upload-generation";
  const markerPayload = JSON.stringify({ instanceId: "si-upload-race", storageUri: "webdav://library/song.flac", uploadNonce: nonce });
  let status = taskStatus;
  let payload = taskPayload;
  let markerExists = opts.marker ?? true;
  let terminalCandidateQuerySeen = false;
  const env = {
    DB: {
      prepare(sql: string) {
        let args: unknown[] = [];
        const statement = {
          bind(...values: unknown[]) { args = values; return statement; },
          async all<T>() {
            if (sql.includes("task_type = 'manual_upload_pending'")) {
              return { results: markerExists ? [{ id: "wm-upload-pending-si-upload-race", payload: markerPayload, created_at: createdAt }] as T[] : [] };
            }
            if (sql.includes("FROM song_instances si")) {
              terminalCandidateQuerySeen = sql.includes("w.status IN ('failed', 'canceled')")
                && sql.includes("CASE WHEN json_valid(w.payload)")
                && sql.includes("$.automaticRecoveryAttempt");
              let recoveryAttempt = 0;
              try { recoveryAttempt = Number((JSON.parse(payload) as { automaticRecoveryAttempt?: unknown }).automaticRecoveryAttempt || 0); }
              catch { /* malformed historical payload gets one recovery attempt */ }
              return {
                results: opts.recoverTerminalTask && terminalCandidateQuerySeen && recoveryAttempt < 1
                  ? [{ id: "si-upload-race", storage_uri: "webdav://library/song.flac", suffix: "flac", size: 900 }] as T[]
                  : [] as T[],
              };
            }
            return { results: [] as T[] };
          },
          async first<T>() {
            if (sql.includes("FROM song_instances")) {
              return { id: "si-upload-race", storage_uri: "webdav://library/song.flac", suffix: "flac", size: 900 } as T;
            }
            if (sql.includes("FROM work_queue WHERE id = ?")) return { status, payload } as T;
            return null;
          },
          async run() {
            if (sql.startsWith("UPDATE work_queue SET payload")) {
              if (status === "queued") payload = String(args[0]);
              return { meta: { changes: status === "queued" ? 1 : 0 } };
            }
            if (sql.startsWith("DELETE FROM work_queue WHERE id = ? AND task_type = 'manual_upload_pending'")) {
              if (args[0] === "wm-upload-pending-si-upload-race" && args[1] === createdAt && args[2] === markerPayload) markerExists = false;
              return { meta: { changes: markerExists ? 0 : 1 } };
            }
            if (sql.includes("INSERT INTO work_queue")) {
              status = "queued";
              payload = String(args[2]);
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
        };
        return statement;
      },
    },
  };
  return {
    env,
    failTask() { status = "failed"; },
    get markerExists() { return markerExists; },
    get terminalCandidateQuerySeen() { return terminalCandidateQuerySeen; },
    get taskPayload() { return payload; },
    nonce,
  };
}

async function main() {
  const staleClaimed = makeEnv("claimed", JSON.stringify({ instanceId: "si-upload-race", sourceUri: "webdav://library/old.flac", suffix: "flac", size: 900, origin: "upload", uploadNonce: "old-generation" }));
  const missed = await recoverPendingUploadMetadata(staleClaimed.env as any);
  assert(missed === 0 && staleClaimed.markerExists, "stale claimed work does not consume the pending marker");

  const staleQueued = makeEnv("queued", JSON.stringify({ instanceId: "si-upload-race", sourceUri: "webdav://library/old.flac", suffix: "flac", size: 900, origin: "upload", uploadNonce: "old-generation" }));
  const refreshed = await recoverPendingUploadMetadata(staleQueued.env as any);
  assert(refreshed === 1 && staleQueued.markerExists, "stale queued work is refreshed while its generation marker stays available for result validation");

  const terminalLegacy = makeEnv("failed", JSON.stringify({ instanceId: "si-upload-race", sourceUri: "webdav://library/song.flac", suffix: "flac", size: 900, origin: "upload" }), {
    marker: false,
    recoverTerminalTask: true,
  });
  const retried = await recoverPendingUploadMetadata(terminalLegacy.env as any);
  assert(terminalLegacy.terminalCandidateQuerySeen && retried === 1
    && JSON.parse(terminalLegacy.taskPayload).automaticRecoveryAttempt === 1,
  "a failed markerless upload task receives one automatic retry");
  terminalLegacy.failTask();
  const exhausted = await recoverPendingUploadMetadata(terminalLegacy.env as any);
  assert(exhausted === 0, "a task that fails after automatic recovery remains terminal for diagnosis");

  if (failures) process.exitCode = 1;
  else console.log("\nALL PASS");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
