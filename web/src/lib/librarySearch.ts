export type LibrarySearchSort = "newest" | "oldestAdded" | "nameAsc" | "nameDesc" | "newestAdded" | "oldestStarred";

export const LIBRARY_PAGE_SIZES = [20, 50, 100, 200, 500] as const;
export type LibraryPageSize = typeof LIBRARY_PAGE_SIZES[number];

export type LibraryLoadMode = "manual" | "automatic";

export function exactPageCount(total: number | null, pageSize: number): number | null {
  if (total === null || !Number.isFinite(total) || total < 0) return null;
  const safePageSize = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : 20;
  return Math.max(1, Math.ceil(total / safePageSize));
}

export function validPageTarget(target: number, currentPage: number, exactPageCount: number | null): number | null {
  if (!Number.isFinite(target) || target < 1) return null;
  const page = Math.floor(target);
  if (page < 1) return null;
  if (exactPageCount !== null && page > exactPageCount) return null;
  const current = Number.isFinite(currentPage) ? Math.max(1, Math.floor(currentPage)) : 1;
  if (exactPageCount === null && page > current + 1) return null;
  return page;
}

export function visibleLibraryItems<T>(items: T[], page: number, pageSize: number, mode: LibraryLoadMode): T[] {
  if (mode === "automatic") {
    const safePageSize = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : 20;
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    return items.slice(0, safePage * safePageSize);
  }
  return paginateLibraryItems(items, page, pageSize).items;
}

export function paginateLibraryItems<T>(items: T[], page: number, pageSize: number): {
  items: T[];
  page: number;
  pageCount: number;
  hasPrevious: boolean;
  hasNext: boolean;
} {
  const safePageSize = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : 20;
  const pageCount = Math.max(1, Math.ceil(items.length / safePageSize));
  const safePage = Number.isFinite(page) ? Math.min(pageCount, Math.max(1, Math.floor(page))) : 1;
  const start = (safePage - 1) * safePageSize;
  return {
    items: items.slice(start, start + safePageSize),
    page: safePage,
    pageCount,
    hasPrevious: safePage > 1,
    hasNext: safePage < pageCount,
  };
}

export function buildLibrarySearchRoute(
  current: Record<string, unknown>,
  query: string,
  lyricsQuery: string,
): Record<string, string | string[]> {
  const next = Object.fromEntries(Object.entries(current).filter(([key]) => key !== "q" && key !== "lyrics")) as Record<string, string | string[]>;
  if (query) next.q = query;
  if (lyricsQuery) next.lyrics = lyricsQuery;
  return next;
}

export function buildLibrarySearchParams(
  query: string,
  lyricsQuery: string,
  sortMode: LibrarySearchSort,
  pageSize: number = 100,
  pages: { artists?: number; albums?: number; songs?: number } = {},
): Record<string, string> {
  const lyrics = lyricsQuery.trim();
  const pageStep = Number.isFinite(pageSize) ? Math.min(500, Math.max(1, Math.floor(pageSize))) : 100;
  const count = pageStep < 500 ? pageStep + 1 : pageStep;
  return {
    query,
    ...(lyrics ? { lyricsQuery: lyrics } : {}),
    artistCount: lyrics ? "0" : String(count),
    artistOffset: String((Math.max(1, Math.floor(pages.artists ?? 1)) - 1) * pageStep),
    albumCount: lyrics ? "0" : String(count),
    albumOffset: String((Math.max(1, Math.floor(pages.albums ?? 1)) - 1) * pageStep),
    songCount: String(count),
    songOffset: String((Math.max(1, Math.floor(pages.songs ?? 1)) - 1) * pageStep),
    songSort: sortMode === "newest" || sortMode === "newestAdded"
      ? "newest"
      : sortMode === "oldestAdded" ? "oldest"
      : sortMode === "nameDesc" ? "titleDesc" : "title",
  };
}
