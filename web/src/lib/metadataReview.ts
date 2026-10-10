export interface MetadataCompletenessCounts {
  total: number;
  incomplete: number;
  complete: number;
  pending: number;
  kept: number;
  queued: number;
  claimed: number;
}

export interface MetadataReviewCandidate {
  source: string;
  songId: string;
  title: string;
  artist: string;
  album?: string;
  albumArtist?: string;
  year?: number;
  lyrics?: string;
}

export interface MetadataReviewItem {
  taskId: string;
  attempts: number;
  payload: Record<string, unknown>;
  result: { status: "pending"; reason?: string; candidates: MetadataReviewCandidate[] };
}

export interface MetadataReviewPage {
  autoEnabled: boolean;
  counts: MetadataCompletenessCounts;
  pending: MetadataReviewItem[];
  nextCursor: string | null;
}

const COUNT_KEYS: Array<keyof MetadataCompletenessCounts> = [
  "total", "incomplete", "complete", "pending", "kept", "queued", "claimed",
];

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseAutoState(value: unknown): boolean {
  if (!record(value) || value.ok !== true || typeof value.enabled !== "boolean") {
    throw new Error("Invalid automatic metadata state response");
  }
  return value.enabled;
}

function parseCandidate(value: unknown): MetadataReviewCandidate {
  if (!record(value) || typeof value.source !== "string" || typeof value.songId !== "string" ||
      typeof value.title !== "string" || typeof value.artist !== "string") {
    throw new Error("Invalid metadata review candidate");
  }
  return value as unknown as MetadataReviewCandidate;
}

function parsePending(value: unknown): MetadataReviewItem {
  if (!record(value) || typeof value.taskId !== "string" || !Number.isSafeInteger(value.attempts) ||
      !record(value.payload) || !record(value.result) || value.result.status !== "pending" ||
      !Array.isArray(value.result.candidates)) {
    throw new Error("Invalid pending metadata review item");
  }
  return {
    taskId: value.taskId,
    attempts: value.attempts as number,
    payload: value.payload,
    result: {
      status: "pending",
      ...(typeof value.result.reason === "string" ? { reason: value.result.reason } : {}),
      candidates: value.result.candidates.map(parseCandidate),
    },
  };
}

export function parseMetadataReviewPage(value: unknown): MetadataReviewPage {
  if (!record(value) || value.ok !== true || typeof value.autoEnabled !== "boolean" ||
      !record(value.counts) || !Array.isArray(value.pending) || value.pending.length > 20 ||
      !(value.nextCursor === null || typeof value.nextCursor === "string")) {
    throw new Error("Invalid metadata status response");
  }
  const counts = {} as MetadataCompletenessCounts;
  for (const key of COUNT_KEYS) {
    const count = value.counts[key];
    if (!Number.isSafeInteger(count) || (count as number) < 0) throw new Error("Invalid metadata status counts");
    counts[key] = count as number;
  }
  if (counts.complete + counts.incomplete > counts.total) throw new Error("Inconsistent metadata completeness counts");
  return {
    autoEnabled: value.autoEnabled,
    counts,
    pending: value.pending.map(parsePending),
    nextCursor: value.nextCursor,
  };
}

export type MetadataReviewDecision = "apply" | "keep" | "retry";

export function metadataReviewRequest(
  item: MetadataReviewItem,
  decision: MetadataReviewDecision,
  candidateIndex?: number,
  result?: unknown,
): Record<string, unknown> {
  if (decision === "apply") {
    if (!Number.isInteger(candidateIndex) || candidateIndex! < 0 || candidateIndex! >= item.result.candidates.length || !record(result)) {
      throw new Error("Applying a candidate requires a resolved candidate result");
    }
    const candidate = item.result.candidates[candidateIndex!];
    const match = record(result.match) ? result.match : undefined;
    if (!match || match.source !== candidate.source || match.songId !== candidate.songId || result.status !== "matched") {
      throw new Error("Resolved metadata does not match the selected candidate");
    }
    return { taskId: item.taskId, attempts: item.attempts, decision, candidateIndex, result };
  }
  return { taskId: item.taskId, attempts: item.attempts, decision };
}
