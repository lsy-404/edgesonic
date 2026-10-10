// SPDX-License-Identifier: AGPL-3.0-or-later

export const WORK_TASK_TYPES = ["metadata", "transcode", "scrape", "lossless"] as const;

export type WorkTaskType = typeof WORK_TASK_TYPES[number];

const ALLOWED_WORK_TASK_TYPES = new Set<string>(WORK_TASK_TYPES);

export function parseWorkTaskTypes(raw: string | null): WorkTaskType[] | null {
  if (raw === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.some((value) =>
    typeof value !== "string" || !ALLOWED_WORK_TASK_TYPES.has(value),
  )) return null;
  if (new Set(parsed).size !== parsed.length) return null;
  return parsed as WorkTaskType[];
}

export function isWorkTaskType(value: unknown): value is WorkTaskType {
  return typeof value === "string" && ALLOWED_WORK_TASK_TYPES.has(value);
}
