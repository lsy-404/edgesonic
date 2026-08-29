export interface MediaSessionTrack {
  title: string;
  artist?: string;
  album?: string;
  artwork?: string;
}

type Action = MediaSessionAction;

export function setupMediaSession(actions: Partial<Record<Action, (details: MediaSessionActionDetails) => void>>): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  for (const [name, handler] of Object.entries(actions)) {
    if (!handler) continue;
    try { navigator.mediaSession.setActionHandler(name as Action, handler); } catch { /* unsupported action */ }
  }
}

export function syncMediaSession(track: MediaSessionTrack | null, state: MediaSessionPlaybackState, position?: { duration: number; position: number; rate?: number }): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = track ? new MediaMetadata({
      title: track.title, artist: track.artist || "", album: track.album || "",
      artwork: track.artwork ? [{ src: track.artwork }] : [],
    }) : null;
    navigator.mediaSession.playbackState = state;
    if (position && position.duration > 0 && Number.isFinite(position.duration)) {
      navigator.mediaSession.setPositionState({
        duration: position.duration,
        position: Math.min(Math.max(position.position, 0), position.duration),
        playbackRate: position.rate || 1,
      });
    }
  } catch { /* media controls are an optional enhancement */ }
}

export function clearMediaSession(): void { syncMediaSession(null, "none"); }
