import type { Track } from "../stores/player";

export interface HomeAlbum {
  id: string;
  name: string;
  artist: string;
  artistId?: string;
  coverArt?: string;
  songCount: number;
  year?: string;
}

export type HomeSection = "newest" | "frequent" | "recent";
export type HomeAlbumRowsLoader = (section: HomeSection) => Promise<Record<string, string>[]>;

export interface HomeSectionsResult {
  albums: Record<HomeSection, HomeAlbum[]>;
  failed: Set<HomeSection>;
}

export function isSuccessfulSubsonicResponse(xml: string): boolean {
  return /<subsonic-response\b[^>]*\bstatus=["']ok["']/i.test(xml)
    && !/<error\b/i.test(xml);
}

export function albumsFromXml(rows: Record<string, string>[]): HomeAlbum[] {
  return rows
    .map((row) => ({
      id: row.id || "",
      name: row.name || "",
      artist: row.artist || "",
      artistId: row.artistId || undefined,
      coverArt: row.coverArt || undefined,
      songCount: Number.parseInt(row.songCount || "0", 10) || 0,
      year: row.year || undefined,
    }))
    .filter((album) => album.id && album.name);
}

export function tracksFromXml(rows: Record<string, string>[], album: HomeAlbum): Track[] {
  return rows
    .map((row) => ({
      id: row.id || "",
      title: row.title || "",
      artist: row.artist || album.artist,
      artistId: row.artistId || album.artistId,
      album: row.album || album.name,
      albumId: row.albumId || album.id,
      coverArt: row.coverArt || album.coverArt,
      duration: Number.parseInt(row.duration || "0", 10) || 0,
      starred: !!row.starred,
      starredAt: row.starred || undefined,
      createdAt: row.created || undefined,
    }))
    .filter((track) => track.id && track.title);
}

export function shuffled<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const selected = Math.floor(Math.random() * (index + 1));
    [result[index], result[selected]] = [result[selected], result[index]];
  }
  return result;
}

/** Keep previously visible sections when one endpoint is temporarily unavailable. */
export async function loadHomeSections(
  loadRows: HomeAlbumRowsLoader,
  previous: Record<HomeSection, HomeAlbum[]>,
): Promise<HomeSectionsResult> {
  const sections: HomeSection[] = ["newest", "frequent", "recent"];
  const settled = await Promise.allSettled(sections.map((section) => loadRows(section)));
  const albums = { ...previous };
  const failed = new Set<HomeSection>();
  settled.forEach((result, index) => {
    const section = sections[index];
    if (result.status === "fulfilled") albums[section] = albumsFromXml(result.value);
    else failed.add(section);
  });
  return { albums, failed };
}
