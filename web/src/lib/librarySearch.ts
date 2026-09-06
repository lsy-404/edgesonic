export type LibrarySearchSort = "newest" | "oldestAdded" | "nameAsc" | "nameDesc" | "newestAdded" | "oldestStarred";

export function buildLibrarySearchParams(
  query: string,
  lyricsQuery: string,
  sortMode: LibrarySearchSort,
): Record<string, string> {
  const lyrics = lyricsQuery.trim();
  return {
    query,
    ...(lyrics ? { lyricsQuery: lyrics } : {}),
    artistCount: lyrics ? "0" : "20",
    albumCount: lyrics ? "0" : "20",
    songCount: "100",
    songSort: sortMode === "newest" || sortMode === "newestAdded"
      ? "newest"
      : sortMode === "oldestAdded" ? "oldest"
      : sortMode === "nameDesc" ? "titleDesc" : "title",
  };
}
