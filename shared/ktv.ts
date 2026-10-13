// SPDX-License-Identifier: AGPL-3.0-or-later

export type KtvQueueMode = "fair" | "fifo";

export interface KtvSelection {
  audioId?: string;
  videoId?: string;
  externalUrl?: string;
  offsetMs?: number;
  listenOnly?: boolean;
}

export interface KtvQueueItem extends KtvSelection {
  id: string;
  participantId: string;
  displayName: string;
  title: string;
  artist?: string;
  duration: number | null;
  status: "resolving" | "queued" | "playing" | "failed";
  error?: string;
  requestedAt: number;
}

export interface KtvRoomSnapshot {
  id: string;
  version: number;
  open: boolean;
  mode: KtvQueueMode;
  current: KtvQueueItem | null;
  queue: KtvQueueItem[];
  participants: { id: string; displayName: string; host: boolean }[];
  playback: { playing: boolean; position: number; updatedAt: number };
  expiresAt: number;
}

export type KtvAction =
  | { action: "enqueue"; selection: KtvSelection }
  | { action: "remove"; itemId: string }
  | { action: "rename"; displayName: string }
  | { action: "mode"; mode: KtvQueueMode }
  | { action: "next"; currentId: string | null }
  | { action: "playback"; currentId: string; playing: boolean; position: number }
  | { action: "heartbeat" }
  | { action: "close" }
  | { action: "rotate" }
  | { action: "comment"; text: string };

export interface KtvComment {
  id: string;
  itemId: string;
  displayName: string;
  text: string;
  time: number;
}
