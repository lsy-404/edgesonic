export interface AlbumDisplayGroupSummary {
  id: string;
  name: string;
  memberAlbumIds: string[];
  memberCount: number;
}

export type AlbumDisplayCard<T extends { id: string }> =
  | { kind: "album"; key: string; album: T }
  | { kind: "group"; key: string; group: AlbumDisplayGroupSummary; representative: T };

export function foldAlbumDisplayCards<T extends { id: string }>(
  albums: T[],
  groups: AlbumDisplayGroupSummary[],
): AlbumDisplayCard<T>[] {
  const groupByAlbumId = new Map<string, AlbumDisplayGroupSummary>();
  for (const group of groups) {
    for (const id of group.memberAlbumIds) groupByAlbumId.set(id, group);
  }

  const seenGroups = new Set<string>();
  const cards: AlbumDisplayCard<T>[] = [];
  for (const album of albums) {
    const group = groupByAlbumId.get(album.id);
    if (!group) {
      cards.push({ kind: "album", key: `album:${album.id}`, album });
    } else if (!seenGroups.has(group.id)) {
      seenGroups.add(group.id);
      cards.push({ kind: "group", key: `group:${group.id}`, group, representative: album });
    }
  }
  return cards;
}
