// SPDX-License-Identifier: AGPL-3.0-or-later
import type { KtvAction, KtvQueueMode, KtvRoomSnapshot } from "../../../shared/ktv";

export interface KtvSettings { enabled: boolean; mode: KtvQueueMode }
export interface KtvRoomResult { room: KtvRoomSnapshot; inviteUrl?: string }
export interface KtvSearchAudio { id: string; title: string; artist: string; duration: number | null }
export interface KtvSearchVideo { id: string; title: string; duration: number | null; provider: string }

export class KtvRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  let data: { ok?: boolean; error?: string } & Record<string, unknown>;
  try { data = await response.json() as typeof data; }
  catch { throw new KtvRequestError("The service returned an unreadable response.", response.status); }
  if (!response.ok || data.ok === false) throw new KtvRequestError(data.error || "The request could not be completed.", response.status);
  return data as T;
}

function json(body: unknown, headers?: HeadersInit): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) };
}

export function fetchKtvSettings() { return request<{ enabled: boolean; mode: KtvQueueMode; ok: true }>("/edgesonic/ktv/settings"); }
export function saveKtvSettings(settings: Partial<KtvSettings>) { return request<{ enabled: boolean; mode: KtvQueueMode; ok: true }>("/edgesonic/ktv/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) }); }

export function createKtvRoom(input: { playerId: string; mode: KtvQueueMode; displayName: string }) {
  return request<{ ok: true; room: KtvRoomSnapshot; controllerToken: string; inviteUrl: string }>("/edgesonic/ktv/rooms", json(input));
}
export function getKtvRoom(roomId: string, controllerToken: string) {
  return request<{ ok: true; room: KtvRoomSnapshot; inviteUrl: string }>(`/edgesonic/ktv/rooms/${encodeURIComponent(roomId)}`, { headers: { "X-KTV-Controller": controllerToken } });
}
export function ktvRoomAction(roomId: string, controllerToken: string, action: KtvAction) {
  return request<{ ok: true; room: KtvRoomSnapshot; inviteUrl?: string }>(`/edgesonic/ktv/rooms/${encodeURIComponent(roomId)}/actions`, json(action, { "X-KTV-Controller": controllerToken }));
}
export function searchKtvRoom(roomId: string, auth: { kind: "controller"; token: string } | { kind: "participant"; token: string }, query: string) {
  const params = new URLSearchParams({ q: query });
  const headers: Record<string, string> = auth.kind === "controller" ? { "X-KTV-Controller": auth.token } : { Authorization: `Bearer ${auth.token}` };
  const prefix = auth.kind === "controller" ? "/edgesonic/ktv" : "/ktv";
  return request<{ ok: true; audio: KtvSearchAudio[]; videos: KtvSearchVideo[] }>(`${prefix}/rooms/${encodeURIComponent(roomId)}/search?${params}`, { headers });
}
export function getKtvLinks(roomId: string, controllerToken: string, audioId: string) {
  return request<{ ok: true; links: Array<{ audioId: string; videoId: string; audioTitle: string; videoTitle: string; offsetMs: number }> }>(`/edgesonic/ktv/rooms/${encodeURIComponent(roomId)}/links?${new URLSearchParams({ audioId })}`, { headers: { "X-KTV-Controller": controllerToken } });
}
export function getParticipantKtvLinks(roomId: string, participantToken: string, audioId: string) {
  return request<{ ok: true; links: Array<{ audioId: string; videoId: string; audioTitle: string; videoTitle: string; offsetMs: number }> }>(`/ktv/rooms/${encodeURIComponent(roomId)}/links?${new URLSearchParams({ audioId })}`, { headers: { Authorization: `Bearer ${participantToken}` } });
}

export function getPublicKtvRoom(roomId: string, invite: string) {
  return request<{ ok: true; room: KtvRoomSnapshot }>(`/ktv/rooms/${encodeURIComponent(roomId)}?${new URLSearchParams({ invite })}`);
}
export function joinKtvRoom(roomId: string, input: { invite: string; displayName: string; participantToken?: string }) {
  return request<{ ok: true; room: KtvRoomSnapshot; participantId: string; participantToken: string }>(`/ktv/rooms/${encodeURIComponent(roomId)}/join`, json(input));
}
export function getGuestKtvState(roomId: string, participantToken: string) {
  return request<{ ok: true; room: KtvRoomSnapshot }>(`/ktv/rooms/${encodeURIComponent(roomId)}/state`, { headers: { Authorization: `Bearer ${participantToken}` } });
}
export function guestKtvAction(roomId: string, participantToken: string, action: KtvAction) {
  return request<{ ok: true; room: KtvRoomSnapshot }>(`/ktv/rooms/${encodeURIComponent(roomId)}/actions`, json(action, { Authorization: `Bearer ${participantToken}` }));
}
export function participantStorageKey(roomId: string) { return `edgesonic:ktv:participant:${roomId}`; }
export const hostStorageKey = "edgesonic:ktv:host";
export const playerIdentityKey = "edgesonic:ktv:player";

export function openKtvSocket(roomId: string, credentials: { kind: "controller"; token: string } | { kind: "participant"; token: string }, onMessage: (data: unknown) => void, onClose: () => void) {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams(credentials.kind === "controller" ? { controller: credentials.token } : { participant: credentials.token });
  const socket = new WebSocket(`${scheme}//${location.host}/${credentials.kind === "controller" ? "edgesonic/ktv" : "ktv"}/rooms/${encodeURIComponent(roomId)}/ws?${params}`);
  socket.addEventListener("message", (event) => {
    try { onMessage(JSON.parse(String(event.data))); } catch { /* ignore malformed room events */ }
  });
  socket.addEventListener("close", onClose);
  return socket;
}
