export interface ListeningProgressUpdate {
  currentTime: number;
  duration: number;
  playing: boolean;
}

export function listeningReportId(track: { id: string; libraryId?: string; streamUrl?: string }): string {
  if (track.libraryId) return track.libraryId;
  return !track.streamUrl && !track.id.startsWith("file:") ? track.id : "";
}

export class ListeningProgress {
  private lastTime: number | null = null;
  private listened = 0;
  private reported = false;

  reset() {
    this.lastTime = null;
    this.listened = 0;
    this.reported = false;
  }

  anchor(currentTime: number) {
    this.lastTime = Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : null;
  }

  update({ currentTime, duration, playing }: ListeningProgressUpdate): boolean {
    if (!Number.isFinite(currentTime) || currentTime < 0) return false;
    const previous = this.lastTime;
    this.lastTime = currentTime;

    if (playing && previous !== null) {
      const elapsed = currentTime - previous;
      if (elapsed > 0 && elapsed <= 5) this.listened += elapsed;
    }

    if (this.reported || !Number.isFinite(duration) || duration <= 0) return false;
    const threshold = Math.min(240, duration / 2);
    if (this.listened < threshold) return false;
    this.reported = true;
    return true;
  }
}

