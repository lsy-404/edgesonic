export const WORK_TASK_TYPES = ["metadata", "transcode", "scrape", "lossless"] as const;
export type WorkTaskType = typeof WORK_TASK_TYPES[number];

export const DEFAULT_WORK_TASK_TYPES: WorkTaskType[] = ["metadata", "transcode", "scrape"];
export const WORK_TASK_TYPES_STORAGE_KEY = "edgesonic:worker_task_types";

export function parseWorkTaskTypes(value: string | null): WorkTaskType[] {
  if (value === null) return [...DEFAULT_WORK_TASK_TYPES];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [...DEFAULT_WORK_TASK_TYPES];
    return WORK_TASK_TYPES.filter((type) => parsed.includes(type));
  } catch {
    return [...DEFAULT_WORK_TASK_TYPES];
  }
}

export function encodeWorkTaskTypes(types: readonly WorkTaskType[]): string {
  return JSON.stringify(WORK_TASK_TYPES.filter((type) => types.includes(type)));
}

export function supportsBrowserFfmpeg(scope: Pick<typeof globalThis, "WebAssembly" | "Worker"> = globalThis): boolean {
  return typeof scope.WebAssembly !== "undefined" && typeof scope.Worker !== "undefined";
}

export function taskTypeLabelKey(type: string): string {
  return WORK_TASK_TYPES.includes(type as WorkTaskType) ? `workMode.tasks.${type}` : "workMode.tasks.unknown";
}
