export const MAX_PAGE_SIZE = 200;
export const MAX_PAGE_OFFSET = 1_000_000;

export function parsePageSize(raw: string | undefined, defaultSize: number): number {
  const parsed = Number.parseInt(raw || "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultSize;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

export function parsePageOffset(raw: string | undefined): number {
  const parsed = Number.parseInt(raw || "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, MAX_PAGE_OFFSET);
}
