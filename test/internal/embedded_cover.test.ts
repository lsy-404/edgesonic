// Run: npx tsx test/internal/embedded_cover.test.ts

import { DatabaseSync } from "node:sqlite";
import { writeEmbeddedCover } from "../../worker/src/utils/embeddedCover";
import {
  markUploadMetadataPending,
  recoverStaleUploadMetadataLeases,
  releaseUploadMetadataLease,
  UPLOAD_METADATA_LEASE_TTL_SECONDS,
} from "../../worker/src/utils/uploadMetadataQueue";

declare global {
  type D1Database = unknown;
  type R2Bucket = unknown;
}

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

async function main() {
  let pointer: string | null = null;
  let reads = 0;
  let releaseReads!: () => void;
  const bothRead = new Promise<void>((resolve) => { releaseReads = resolve; });
  const db = {
    prepare(sql: string) {
      const statement = {
        args: [] as unknown[],
        bind(...args: unknown[]) { statement.args = args; return statement; },
        async first<T>() {
          if (sql.includes("SELECT a.id AS album_id")) {
            reads++;
            if (reads === 2) releaseReads();
            await bothRead;
            return { album_id: "al-race", cover_r2_key: pointer } as T;
          }
          if (sql.includes("SELECT cover_r2_key FROM albums")) return { cover_r2_key: pointer } as T;
          throw new Error(`Unexpected first query: ${sql}`);
        },
        async run() {
          if (sql.startsWith("UPDATE albums SET cover_r2_key")) {
            if (pointer !== null) return { meta: { changes: 0 } };
            pointer = String(statement.args[0]);
            return { meta: { changes: 1 } };
          }
          throw new Error(`Unexpected run query: ${sql}`);
        },
      };
      return statement;
    },
  };
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    async put(key: string, bytes: Uint8Array) { objects.set(key, bytes); },
    async delete(key: string) { objects.delete(key); },
  };

  const results = await Promise.all([
    writeEmbeddedCover(db as any, bucket as any, "master-one", { data: "AQID", mime: "image/png" }),
    writeEmbeddedCover(db as any, bucket as any, "master-two", { data: "BAUG", mime: "image/png" }),
  ]);
  assert(results.filter((status) => status === "saved").length === 1, "one concurrent cover upload wins the album CAS");
  assert(results.filter((status) => status === "preserved").length === 1, "the CAS loser reports the winning cover as preserved");
  assert(objects.size === 1 && pointer !== null && objects.has(pointer), "losing immutable candidate is deleted while the winning key remains readable");
  assert(pointer?.startsWith("covers/al-race/") === true, "album pointer stores the unique candidate key");

  let ambiguousPointer: string | null = null;
  const ambiguousDb = {
    prepare(sql: string) {
      const statement = {
        args: [] as unknown[],
        bind(...args: unknown[]) { statement.args = args; return statement; },
        async first<T>() {
          if (sql.includes("SELECT a.id AS album_id")) return { album_id: "al-ambiguous", cover_r2_key: null } as T;
          if (sql.includes("SELECT cover_r2_key FROM albums")) return { cover_r2_key: ambiguousPointer } as T;
          throw new Error(`Unexpected first query: ${sql}`);
        },
        async run() {
          ambiguousPointer = String(statement.args[0]);
          return { meta: {} };
        },
      };
      return statement;
    },
  };
  const ambiguousObjects = new Set<string>();
  const ambiguousBucket = {
    async put(key: string) { ambiguousObjects.add(key); },
    async delete(key: string) { ambiguousObjects.delete(key); },
  };
  const ambiguousStatus = await writeEmbeddedCover(ambiguousDb as any, ambiguousBucket as any, "master-ambiguous", { data: "AQID" });
  assert(ambiguousStatus === "saved" && ambiguousPointer !== null && ambiguousObjects.has(ambiguousPointer),
    "ambiguous D1 update response rereads the pointer before candidate cleanup");

  let cleanedKey = "";
  const throwingDb = {
    prepare(sql: string) {
      const statement = {
        args: [] as unknown[],
        bind(...args: unknown[]) { statement.args = args; return statement; },
        async first<T>() { return { album_id: "al-error", cover_r2_key: null } as T; },
        async run() { throw new Error("database failure"); },
      };
      return statement;
    },
  };
  const throwingBucket = {
    async put(key: string) { cleanedKey = key; },
    async delete(key: string) { if (key === cleanedKey) cleanedKey = ""; },
  };
  let rethrown = false;
  try {
    await writeEmbeddedCover(throwingDb as any, throwingBucket as any, "master-error", { data: "AQID" });
  } catch { rethrown = true; }
  assert(rethrown && cleanedKey === "", "database failure cleans its candidate object and rethrows");

  const leaseSqlite = new DatabaseSync(":memory:");
  leaseSqlite.exec(`
    CREATE TABLE work_queue (
      id TEXT PRIMARY KEY, task_type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
      required_caps TEXT, priority INTEGER DEFAULT 5, claimed_by TEXT, claimed_at INTEGER,
      heartbeat_at INTEGER, result_json TEXT, error_message TEXT, attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 3, created_at INTEGER DEFAULT 0
    );
    CREATE TABLE albums (id TEXT PRIMARY KEY, cover_r2_key TEXT, updated_at INTEGER DEFAULT 0);
    CREATE TABLE song_masters (id TEXT PRIMARY KEY, album_id TEXT NOT NULL);
    INSERT INTO albums (id) VALUES ('al-stale');
    INSERT INTO song_masters (id, album_id) VALUES ('master-stale', 'al-stale');
  `);
  const leaseDb = {
    prepare(sql: string) {
      const stmt = leaseSqlite.prepare(sql);
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
  } as unknown as D1Database;
  const now = Math.floor(Date.now() / 1000);
  const oldLease = await markUploadMetadataPending(leaseDb, "inst-stale", "webdav://dav/stale.png", "old-generation", now);
  assert(!!oldLease, "old generation holds the upload lease during cover publication");
  let signalPut!: () => void;
  let resumePut!: () => void;
  const putEntered = new Promise<void>((resolve) => { signalPut = resolve; });
  const putGate = new Promise<void>((resolve) => { resumePut = resolve; });
  const staleObjects = new Set<string>();
  const staleBucket = {
    async put(key: string) {
      staleObjects.add(key);
      signalPut();
      await putGate;
    },
    async delete(key: string) { staleObjects.delete(key); },
  };
  const staleWrite = writeEmbeddedCover(
    leaseDb,
    staleBucket as any,
    "master-stale",
    { data: "AQID" },
    { markerId: "wm-upload-pending-inst-stale", payload: oldLease!.payload },
  );
  await putEntered;
  leaseSqlite.prepare("UPDATE work_queue SET heartbeat_at = 1 WHERE id = ?").run("wm-upload-pending-inst-stale");
  assert(await recoverStaleUploadMetadataLeases(leaseDb, now + UPLOAD_METADATA_LEASE_TTL_SECONDS + 1) === 1,
    "expired cover holder is released by generation recovery");
  const nextLease = await markUploadMetadataPending(leaseDb, "inst-stale", "webdav://dav/stale.png", "new-generation", now + 1);
  assert(!!nextLease, "new overwrite establishes its generation while old cover PUT is paused");
  resumePut();
  const staleStatus = await staleWrite;
  const stalePointer = (leaseSqlite.prepare("SELECT cover_r2_key FROM albums WHERE id = 'al-stale'").get() as { cover_r2_key: string | null }).cover_r2_key;
  assert(staleStatus === "invalid" && stalePointer === null && staleObjects.size === 0,
    "cover candidate is removed when lease changes before D1 publication");
  if (oldLease) await releaseUploadMetadataLease(leaseDb, oldLease, false);
  if (nextLease) await releaseUploadMetadataLease(leaseDb, nextLease, false);
  leaseSqlite.close();

  if (failures > 0) process.exitCode = 1;
  else console.log("\nALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
