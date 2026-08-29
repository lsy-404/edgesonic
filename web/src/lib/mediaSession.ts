export interface MediaSessionTrack {
  title: string;
  artist?: string;
  album?: string;
  artwork?: string;
}

export interface MediaSessionControls {
  currentTime: () => number;
  play: () => void;
  pause: () => void;
  previous: () => void;
  next: () => void;
  seek: (seconds: number) => void;
}

export function setupMediaSession(controls: MediaSessionControls): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const actions: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
    play: controls.play,
    pause: controls.pause,
    previoustrack: controls.previous,
    nexttrack: controls.next,
    seekbackward: (details) => controls.seek(controls.currentTime() - (details.seekOffset ?? 10)),
    seekforward: (details) => controls.seek(controls.currentTime() + (details.seekOffset ?? 10)),
    seekto: (details) => {
      if (details.seekTime != null) controls.seek(details.seekTime);
    },
  };
  for (const [name, handler] of Object.entries(actions)) {
    if (!handler) continue;
    try { navigator.mediaSession.setActionHandler(name as MediaSessionAction, handler); } catch { /* unsupported action */ }
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
