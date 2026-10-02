export type LibrarySearchSort = "newest" | "oldestAdded" | "nameAsc" | "nameDesc" | "newestAdded" | "oldestStarred";

export const LIBRARY_PAGE_SIZES = [20, 50, 100, 200, 500] as const;
export type LibraryPageSize = typeof LIBRARY_PAGE_SIZES[number];

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
