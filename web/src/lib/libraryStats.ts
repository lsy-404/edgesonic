export interface LibraryStatsResponse {
  ok: boolean;
  artists: number;
  albums: number;
  songs: number;
  updatedAt: number | null;
  stale: boolean;
  ready: boolean;
}

export const LIBRARY_STATS_REFRESH_ATTEMPTS = 5;
export const LIBRARY_STATS_REFRESH_DELAY_MS = 1_000;

export function canRebuildLibraryStats(isAdmin: boolean, hasReclaimPermission: boolean): boolean {
  return isAdmin && hasReclaimPermission;
}

export async function refreshLibraryStatsWhileStale(
  read: () => Promise<LibraryStatsResponse>,
  onSnapshot: (snapshot: LibraryStatsResponse) => void,
  isActive: () => boolean,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  for (let attempt = 0; attempt < LIBRARY_STATS_REFRESH_ATTEMPTS; attempt++) {
    await wait(LIBRARY_STATS_REFRESH_DELAY_MS);
    if (!isActive()) return;
    try {
      const snapshot = await read();
      if (!isActive()) return;
      onSnapshot(snapshot);
      if (snapshot.ready && !snapshot.stale) return;
    } catch {
      if (!isActive()) return;
    }
  }
}
