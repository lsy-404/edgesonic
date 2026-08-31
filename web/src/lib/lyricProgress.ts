// SPDX-License-Identifier: AGPL-3.0-or-later

export interface TimedCue {
  start: number;
  end?: number;
}

export interface TimedLyricLine {
  time: number;
  synced: boolean;
  cues: TimedCue[];
}

export function cuePlaybackProgress(
  lines: TimedLyricLine[],
  lineIndex: number,
  cueIndex: number,
  currentTime: number,
  duration: number,
): number {
  const line = lines[lineIndex];
  const cue = line?.cues[cueIndex];
  if (!cue || !line.synced) return 0;
  const nextLine = lines.slice(lineIndex + 1).find((candidate) => candidate.synced);
  const end = cue.end ?? line.cues[cueIndex + 1]?.start ?? nextLine?.time ?? duration;
  if (!Number.isFinite(end) || end <= cue.start) return currentTime >= cue.start ? 1 : 0;
  return Math.min(1, Math.max(0, (currentTime - cue.start) / (end - cue.start)));
}
