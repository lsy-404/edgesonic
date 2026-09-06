export function clampVolume(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

export function volumePercent(value: number): number {
  return Math.round(clampVolume(value) * 100);
}

export function toggledVolume(current: number, lastAudible: number): number {
  return current > 0 ? 0 : (lastAudible > 0 ? clampVolume(lastAudible) : 0.5);
}
