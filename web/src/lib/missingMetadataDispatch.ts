export type MissingMetadataDispatchPage = {
  ok: true;
  scanned: number;
  enqueued: number;
  skipped: number;
  nextCursor: string | null;
};

export type MissingMetadataDispatchTotals = {
  scanned: number;
  enqueued: number;
  skipped: number;
};

export type MissingMetadataDispatchProgress = MissingMetadataDispatchTotals & {
  nextCursor: string | undefined;
};

type DispatchOptions = {
  after?: string;
  signal: AbortSignal;
  request: (after: string | undefined, signal: AbortSignal) => Promise<unknown>;
  onPage: (progress: MissingMetadataDispatchProgress) => void;
};

const PAGE_SIZE = 100;

function readCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > PAGE_SIZE) {
    throw new Error(`Invalid ${field} count`);
  }
  return value;
}

function readPage(value: unknown): MissingMetadataDispatchPage {
  if (value === null || typeof value !== "object") throw new Error("Invalid dispatch response");
  const record = value as Record<string, unknown>;
  if (record.ok !== true) {
    throw new Error(typeof record.error === "string" ? record.error : "Dispatch failed");
  }
  if (!("nextCursor" in record)) throw new Error("Dispatch response is missing its next cursor");
  const nextCursor = record.nextCursor;
  if (nextCursor !== null && (typeof nextCursor !== "string" || nextCursor.length === 0)) {
    throw new Error("Invalid dispatch cursor");
  }
  return {
    ok: true,
    scanned: readCount(record.scanned, "scanned"),
    enqueued: readCount(record.enqueued, "enqueued"),
    skipped: readCount(record.skipped, "skipped"),
    nextCursor,
  };
}

export async function dispatchMissingMetadataPages({ after, signal, request, onPage }: DispatchOptions): Promise<MissingMetadataDispatchProgress> {
  let cursor = after;
  let scanned = 0;
  let enqueued = 0;
  let skipped = 0;

  while (!signal.aborted) {
    const page = readPage(await request(cursor, signal));
    if (signal.aborted) break;
    if (page.nextCursor !== null && cursor !== undefined && page.nextCursor <= cursor) {
      throw new Error("Dispatch cursor did not advance");
    }
    scanned += page.scanned;
    enqueued += page.enqueued;
    skipped += page.skipped;
    cursor = page.nextCursor ?? undefined;
    const progress = { scanned, enqueued, skipped, nextCursor: cursor };
    onPage(progress);
    if (cursor === undefined) return progress;
  }

  return { scanned, enqueued, skipped, nextCursor: cursor };
}
