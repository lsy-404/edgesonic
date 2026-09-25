import { DatabaseSync } from "node:sqlite";
import {
  acquireUploadMetadataLease,
  markUploadMetadataPending,
  recoverStaleUploadMetadataLeases,
  releaseUploadMetadataLease,
  UPLOAD_METADATA_LEASE_TTL_SECONDS,
} from "../../worker/src/utils/uploadMetadataQueue";

declare global { type D1Database = unknown; type D1PreparedStatement = unknown; }

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE work_queue (
    id TEXT PRIMARY KEY, task_type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
    required_caps TEXT, priority INTEGER DEFAULT 5, claimed_by TEXT, claimed_at INTEGER,
    heartbeat_at INTEGER, result_json TEXT, error_message TEXT, attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3, created_at INTEGER DEFAULT 0
  )`);
  const db = {
    prepare(sql: string) {
      const stmt = sqlite.prepare(sql);
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) { args = values; return this; },
        async first<T>() { return (stmt.get(...args) as T | undefined) ?? null; },
        async run() {
          const result = stmt.run(...args);
          return { meta: { changes: Number(result.changes) } };
        },
      };
    },
  };
  return { sqlite, db: db as unknown as D1Database };
}

async function main() {
  console.log("Upload metadata lease excludes overwrite, then recovers a dead holder:");
  {
    const { sqlite, db } = makeDb();
    const id = "si-lease";
    const uri = "webdav://dav/lease.m4a";
    const uploadLease = await markUploadMetadataPending(db, id, uri, "generation-1");
    assert(!!uploadLease, "initial generation is exclusively held while bytes are written");
    assert(!(await markUploadMetadataPending(db, id, uri, "generation-2")), "concurrent overwrite cannot replace an active upload generation");
    if (uploadLease) await releaseUploadMetadataLease(db, uploadLease, false);
    const lease = await acquireUploadMetadataLease(db, id, uri, "generation-1");
    assert(!!lease, "matching task acquires the marker lease");
    assert(!(await markUploadMetadataPending(db, id, uri, "generation-2")), "live lease fences an overwrite");
    const now = Math.floor(Date.now() / 1000);
    assert(await recoverStaleUploadMetadataLeases(db, now + UPLOAD_METADATA_LEASE_TTL_SECONDS - 1) === 0, "fresh heartbeat prevents stale recovery");
    sqlite.prepare("UPDATE work_queue SET heartbeat_at = 1 WHERE id = ?").run(`wm-upload-pending-${id}`);
    assert(await recoverStaleUploadMetadataLeases(db, now + UPLOAD_METADATA_LEASE_TTL_SECONDS + 1) === 1, "dead lease is recovered after its heartbeat expires");
    const row = sqlite.prepare("SELECT status FROM work_queue WHERE id = ?").get(`wm-upload-pending-${id}`) as { status: string };
    assert(row.status === "canceled", "recovered marker remains available for metadata recovery");
    if (lease) await releaseUploadMetadataLease(db, lease, true);
    const next = await markUploadMetadataPending(db, id, uri, "generation-2");
    assert(!!next, "a new generation can replace the recovered marker");
    if (next) await releaseUploadMetadataLease(db, next, false);
  }

  console.log(`\n${failures === 0 ? "✓ ALL PASS" : `✗ ${failures} FAILED`}`);
  if (failures) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
