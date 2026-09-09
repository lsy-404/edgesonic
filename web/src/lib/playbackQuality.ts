// SPDX-License-Identifier: AGPL-3.0-or-later

export type PlaybackQuality =
  | "auto"
  | "mp3-128"
  | "mp3-192"
  | "aac-128"
  | "opus-128"
  | "flac"
  | "wav";

export interface StreamQualityParams {
  format?: string;
  maxBitRate?: number;
}

export const PLAYBACK_QUALITY_OPTIONS: Record<PlaybackQuality, StreamQualityParams> = {
  // An explicit raw request prevents intermediaries from interpreting auto
  // as a codec target and guarantees the stored bytes are streamed unchanged.
  auto: { format: "raw" },
  "mp3-128": { format: "mp3", maxBitRate: 128 },
  "mp3-192": { format: "mp3", maxBitRate: 192 },
  "aac-128": { format: "aac", maxBitRate: 128 },
  "opus-128": { format: "opus", maxBitRate: 128 },
  flac: { format: "flac" },
  wav: { format: "wav" },
};

export function normalizePlaybackQuality(value: string | null | undefined): PlaybackQuality {
  return value && Object.prototype.hasOwnProperty.call(PLAYBACK_QUALITY_OPTIONS, value)
    ? value as PlaybackQuality
    : "auto";
}

export function isAutomaticPlaybackQuality(value: string | null | undefined): boolean {
  return normalizePlaybackQuality(value) === "auto";
}

export function streamQualityParamsForQuality(value: string | null | undefined): StreamQualityParams {
  return PLAYBACK_QUALITY_OPTIONS[normalizePlaybackQuality(value)];
}
