// SPDX-License-Identifier: AGPL-3.0-or-later

import type { KtvAction, KtvComment, KtvQueueItem, KtvQueueMode, KtvRoomSnapshot, KtvSelection } from "../../../shared/ktv";
import { createQueries } from "../db/queries";
import { requestMedia, resolveExternalMedia } from "../media/loader";
import { getVideo, listVideos } from "../media/videos";
import { resolveActivation } from "../utils/activation";
import { hasPermission } from "../utils/permissions";

interface Participant {
  id: string;
  token: string;
  displayName: string;
  host: boolean;
  lastServed: number;
  enqueueTimes: number[];
  commentTimes: number[];
}

interface QueueItem extends KtvQueueItem {
  sequence: number;
}

interface Room {
  id: string;
  owner: string;
  playerId: string;
  controller: string;
  invite: string;
  origin: string;
  generation: number;
  mode: KtvQueueMode;
  participants: Participant[];
  queue: QueueItem[];
  current: QueueItem | null;
  playback: KtvRoomSnapshot["playback"];
  autoplay: boolean;
  turn: number;
  sequence: number;
  version: number;
  expiresAt: number;
  leaseUntil: number;
}

interface SocketIdentity {
  participantId: string;
  host: boolean;
  generation: number;
}

class RoomError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function secret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) => value.toString(16).padStart(2, "0")).join("");
}

function displayName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 32) throw new RoomError("Choose a name of 1 to 32 characters", 400);
  return value.trim();
}

function selection(value: unknown): KtvSelection {
  if (!value || typeof value !== "object") throw new RoomError("Choose a song or video", 400);
  const input = value as Record<string, unknown>;
  const result: KtvSelection = {};
  for (const name of ["audioId", "videoId"] as const) {
    if (input[name] !== undefined) {
      if (typeof input[name] !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(input[name])) throw new RoomError("Invalid media identifier", 400);
      result[name] = input[name];
    }
  }
  if (input.externalUrl !== undefined) {
    if (typeof input.externalUrl !== "string" || input.externalUrl.length > 2048) throw new RoomError("Invalid video link", 400);
    const ref = input.externalUrl.trim();
    if (!/^(BV[0-9A-Za-z]{10}|av\s*\d+)$/i.test(ref)) {
      let url: URL;
      try { url = new URL(ref); } catch { throw new RoomError("Use a Bilibili or YouTube video link", 400); }
      if (url.protocol !== "https:" || url.username || url.password || url.port
        || !["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "bilibili.com", "www.bilibili.com", "m.bilibili.com", "b23.tv"].includes(url.hostname)) {
        throw new RoomError("Use a Bilibili or YouTube video link", 400);
      }
    }
    result.externalUrl = ref;
  }
  if ((!result.audioId && !result.videoId && !result.externalUrl) || (result.videoId && result.externalUrl)) throw new RoomError("Choose one video source", 400);
  const offset = input.offsetMs ?? 0;
  if (typeof offset !== "number" || !Number.isFinite(offset) || Math.abs(offset) > 3_600_000) throw new RoomError("Invalid synchronization offset", 400);
  result.offsetMs = Math.round(offset);
  result.listenOnly = !result.audioId && input.listenOnly === true;
  return result;
}

function ordered(room: Room): QueueItem[] {
  const pending = room.queue.filter((item) => item.status !== "failed").sort((a, b) => a.sequence - b.sequence);
  if (room.mode === "fifo") return pending;
  const lastServed = new Map(room.participants.map((person) => [person.id, person.lastServed]));
  let turn = room.turn;
  const result: QueueItem[] = [];
  while (pending.length) {
    let next = 0;
    for (let index = 1; index < pending.length; index++) {
      if ((lastServed.get(pending[index].participantId) ?? 0) < (lastServed.get(pending[next].participantId) ?? 0)) next = index;
    }
    const [item] = pending.splice(next, 1);
    result.push(item);
    lastServed.set(item.participantId, ++turn);
  }
  return result;
}

function publicItem(item: QueueItem): KtvQueueItem {
  const { sequence: _sequence, ...value } = item;
  return value;
}

function snapshot(room: Room): KtvRoomSnapshot {
  return {
    id: room.id, version: room.version, open: true, mode: room.mode,
    current: room.current ? publicItem(room.current) : null,
    queue: [...ordered(room), ...room.queue.filter((item) => item.status === "failed")].map(publicItem),
    participants: room.participants.map(({ id, displayName, host }) => ({ id, displayName, host })),
    playback: room.playback, expiresAt: room.expiresAt,
  };
}

function advance(room: Room): void {
  if (room.current) return;
  const next = ordered(room)[0];
  if (!next || next.status !== "queued") return;
  room.queue = room.queue.filter((item) => item.id !== next.id);
  room.current = { ...next, status: "playing" };
  const person = room.participants.find((candidate) => candidate.id === next.participantId);
  if (person) person.lastServed = ++room.turn;
  room.playback = { playing: true, position: 0, updatedAt: Date.now() };
}

export class KtvRoom implements DurableObject {
  constructor(private ctx: DurableObjectState, private env: Env) {
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS room_state (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL)");
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private read(): Room | null {
    const rows = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM room_state WHERE id = 1").toArray();
    return rows[0] ? JSON.parse(rows[0].value) as Room : null;
  }

  private save(room: Room, broadcast = true): void {
    room.version++;
    this.ctx.storage.sql.exec("INSERT INTO room_state (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value", JSON.stringify(room));
    if (broadcast) this.broadcast({ type: "state", room: snapshot(room) });
  }

  private active(): Room {
    const room = this.read();
    if (!room) throw new RoomError("Room is unavailable", 404);
    if (Math.min(room.expiresAt, room.leaseUntil) <= Date.now()) {
      this.close();
      throw new RoomError("Room is closed", 410);
    }
    return room;
  }

  private broadcast(value: unknown): void {
    const message = JSON.stringify(value);
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(message); } catch { socket.close(1011, "Reconnect required"); }
    }
  }

  private close(): void {
    this.ctx.storage.sql.exec("DELETE FROM room_state");
    this.broadcast({ type: "closed" });
    for (const socket of this.ctx.getWebSockets()) socket.close(1000, "Room closed");
  }

  private identity(room: Room, request: Request): Participant {
    const owner = request.headers.get("X-KTV-Owner");
    if (owner) {
      if (owner !== room.owner || request.headers.get("X-KTV-Controller") !== room.controller) throw new RoomError("Room controller is unavailable", 403);
      return room.participants.find((person) => person.host)!;
    }
    const token = request.headers.get("Authorization")?.replace(/^Bearer /i, "") || "";
    const person = room.participants.find((candidate) => !candidate.host && candidate.token === token);
    if (!person) throw new RoomError("Join this room again", 403);
    return person;
  }

  private inviteUrl(room: Room): string {
    return `${room.origin}/#/ktv/join/${room.id}?invite=${room.invite}`;
  }

  private async body(request: Request): Promise<Record<string, unknown>> {
    const raw = await request.text();
    if (raw.length > 8192) throw new RoomError("Request is too large", 413);
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value;
    } catch { throw new RoomError("Invalid request", 400); }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/create" && request.method === "POST") return await this.create(request);
      let room = this.active();
      if (url.pathname === "/disable" && request.method === "POST") {
        if (request.headers.get("X-KTV-Owner") !== room.owner) throw new RoomError("Not allowed", 403);
        this.close();
        return Response.json({ ok: true });
      }
      if (!await this.enabled(room.owner)) { this.close(); throw new RoomError("Room is closed", 410); }
      room = this.active();
      if (url.pathname === "/preview" && request.method === "GET") {
        if (url.searchParams.get("invite") !== room.invite) throw new RoomError("Room is unavailable", 404);
        return Response.json({ ok: true, room: snapshot(room) }, { headers: { "Cache-Control": "no-store" } });
      }
      if (url.pathname === "/join" && request.method === "POST") return await this.join(room, request);
      const person = this.identity(room, request);
      if (url.pathname === "/ws") return this.connectSocket(room, person, request);
      if (url.pathname === "/state" && request.method === "GET") return Response.json({ ok: true, room: snapshot(room), ...(person.host ? { inviteUrl: this.inviteUrl(room) } : {}) });
      if (url.pathname === "/search" && request.method === "GET") return await this.search(room, url);
      if (url.pathname === "/links" && request.method === "GET") return await this.links(room, url);
      if (url.pathname === "/actions" && request.method === "POST") {
        const action = await this.body(request);
        return await this.action(person.id, action as unknown as KtvAction, room.generation);
      }
      throw new RoomError("Not found", 404);
    } catch (error) {
      return Response.json({ ok: false, error: error instanceof RoomError ? error.message : "Room request failed" }, {
        status: error instanceof RoomError ? error.status : 500, headers: { "Cache-Control": "no-store" },
      });
    }
  }

  private async create(request: Request): Promise<Response> {
    const owner = request.headers.get("X-KTV-Owner");
    const origin = request.headers.get("X-KTV-Origin");
    if (!owner || !origin) throw new RoomError("Sign in to open a room", 403);
    const body = await this.body(request);
    if (typeof body.playerId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(body.playerId)) throw new RoomError("Invalid playback instance", 400);
    const existing = this.read();
    if (existing && Math.min(existing.expiresAt, existing.leaseUntil) > Date.now()) {
      if (existing.owner !== owner || existing.playerId !== body.playerId) throw new RoomError("Playback instance is already in use", 409);
      return Response.json({ ok: true, room: snapshot(existing), controllerToken: existing.controller, inviteUrl: this.inviteUrl(existing) });
    }
    if (existing) this.close();
    const host: Participant = { id: crypto.randomUUID(), token: secret(), displayName: displayName(body.displayName), host: true, lastServed: 0, enqueueTimes: [], commentTimes: [] };
    const now = Date.now();
    const room: Room = {
      id: this.ctx.id.toString(), owner, origin, playerId: body.playerId,
      controller: secret(), invite: secret(), generation: now,
      mode: body.mode === "fifo" ? "fifo" : "fair", participants: [host], queue: [], current: null,
      playback: { playing: false, position: 0, updatedAt: now }, autoplay: false,
      turn: 0, sequence: 0, version: 0, expiresAt: now + 12 * 60 * 60 * 1000, leaseUntil: now + 120_000,
    };
    this.save(room);
    await this.ctx.storage.setAlarm(room.leaseUntil);
    return Response.json({ ok: true, room: snapshot(room), controllerToken: room.controller, inviteUrl: this.inviteUrl(room) }, { status: 201 });
  }

  private async join(initial: Room, request: Request): Promise<Response> {
    const body = await this.body(request);
    const room = this.active();
    if (initial.generation !== room.generation || body.invite !== room.invite) throw new RoomError("Room invitation has expired", 403);
    const name = displayName(body.displayName);
    let person = typeof body.participantToken === "string" ? room.participants.find((candidate) => !candidate.host && candidate.token === body.participantToken) : undefined;
    if (!person) {
      if (room.participants.length >= 64) throw new RoomError("Room is full", 429);
      person = { id: crypto.randomUUID(), token: secret(), displayName: name, host: false, lastServed: room.turn, enqueueTimes: [], commentTimes: [] };
      room.participants.push(person);
    } else person.displayName = name;
    this.renameItems(room, person);
    this.save(room);
    return Response.json({ ok: true, room: snapshot(room), participantId: person.id, participantToken: person.token });
  }

  private connectSocket(room: Room, person: Participant, request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new RoomError("WebSocket required", 426);
    for (const socket of this.ctx.getWebSockets()) {
      const identity = socket.deserializeAttachment() as SocketIdentity | null;
      if (identity?.participantId === person.id) socket.close(1000, "Connected in another tab");
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ participantId: person.id, host: person.host, generation: room.generation } satisfies SocketIdentity);
    pair[1].send(JSON.stringify({ type: "state", room: snapshot(room) }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private renameItems(room: Room, person: Participant): void {
    for (const item of [...room.queue, ...(room.current ? [room.current] : [])]) {
      if (item.participantId === person.id) item.displayName = person.displayName;
    }
  }

  private async action(participantId: string, action: KtvAction, generation: number): Promise<Response> {
    const room = this.active();
    const person = room.participants.find((candidate) => candidate.id === participantId);
    if (!person || room.generation !== generation) throw new RoomError("Join this room again", 403);
    if (!["enqueue", "remove", "rename", "comment"].includes(action.action) && !person.host) throw new RoomError("Only the host can control playback", 403);
    switch (action.action) {
      case "heartbeat":
        room.leaseUntil = Math.min(Date.now() + 120_000, room.expiresAt);
        this.save(room, false);
        await this.ctx.storage.setAlarm(room.leaseUntil);
        break;
      case "close":
        this.close();
        return Response.json({ ok: true, room: { ...snapshot(room), open: false, current: null, queue: [] } });
      case "rotate":
        room.invite = secret();
        room.generation++;
        for (const candidate of room.participants) if (!candidate.host) candidate.token = secret();
        for (const socket of this.ctx.getWebSockets()) {
          const identity = socket.deserializeAttachment() as SocketIdentity;
          if (identity.host) socket.serializeAttachment({ ...identity, generation: room.generation });
          else { socket.send(JSON.stringify({ type: "closed" })); socket.close(1000, "Invitation changed"); }
        }
        this.save(room);
        break;
      case "mode":
        if (action.mode !== "fair" && action.mode !== "fifo") throw new RoomError("Invalid queue mode", 400);
        room.mode = action.mode;
        this.save(room);
        break;
      case "rename":
        person.displayName = displayName(action.displayName);
        this.renameItems(room, person);
        this.save(room);
        break;
      case "remove": {
        const item = room.queue.find((candidate) => candidate.id === action.itemId);
        if (!item) throw new RoomError("Request was not found", 404);
        if (!person.host && item.participantId !== person.id) throw new RoomError("You can only remove your own requests", 403);
        room.queue = room.queue.filter((candidate) => candidate.id !== item.id);
        if (room.autoplay) advance(room);
        this.save(room);
        break;
      }
      case "next":
        if ((room.current?.id ?? null) !== action.currentId) throw new RoomError("Playback has already advanced", 409);
        room.current = null;
        room.playback = { playing: false, position: 0, updatedAt: Date.now() };
        room.autoplay = true;
        advance(room);
        this.save(room);
        break;
      case "playback":
        if (!room.current || action.currentId !== room.current.id) throw new RoomError("Playback has already advanced", 409);
        if (typeof action.playing !== "boolean" || !Number.isFinite(action.position) || action.position < 0 || action.position > 86_400) throw new RoomError("Invalid playback position", 400);
        room.playback = { playing: action.playing, position: action.position, updatedAt: Date.now() };
        this.save(room);
        break;
      case "enqueue": {
        const selected = selection(action.selection);
        const now = Date.now();
        person.enqueueTimes = person.enqueueTimes.filter((time) => time > now - 60_000);
        if (person.enqueueTimes.length >= 5 || room.queue.filter((item) => item.participantId === person.id).length >= 20 || room.queue.length >= 200) throw new RoomError("Request limit reached; try again later", 429);
        person.enqueueTimes.push(now);
        const item: QueueItem = {
          ...selected, id: crypto.randomUUID(), participantId: person.id, displayName: person.displayName,
          title: "Preparing media", duration: null, status: "resolving", requestedAt: now, sequence: ++room.sequence,
        };
        room.queue.push(item);
        this.save(room);
        this.ctx.waitUntil(this.prepare(item, room.controller));
        break;
      }
      case "comment": {
        if (!room.current || typeof action.text !== "string" || !action.text.trim() || action.text.length > 120) throw new RoomError("Enter a comment of 1 to 120 characters during playback", 400);
        const now = Date.now();
        person.commentTimes = person.commentTimes.filter((time) => time > now - 60_000);
        if (person.commentTimes.length >= 10) throw new RoomError("Comment limit reached", 429);
        person.commentTimes.push(now);
        const time = room.playback.position + (room.playback.playing ? Math.max(0, now - room.playback.updatedAt) / 1000 : 0);
        const comment: KtvComment = { id: crypto.randomUUID(), itemId: room.current.id, displayName: person.displayName, text: action.text.trim(), time };
        this.save(room, false);
        this.broadcast({ type: "comment", comment });
        break;
      }
      default: throw new RoomError("Unknown room action", 400);
    }
    return Response.json({ ok: true, room: snapshot(room), ...(person.host ? { inviteUrl: this.inviteUrl(room) } : {}) });
  }

  private async prepare(item: QueueItem, controller: string): Promise<void> {
    try {
      let title = "";
      let artist: string | undefined;
      let duration: number | null = null;
      if (item.audioId) {
        const audio = await createQueries(this.env.DB).getSongMaster(item.audioId);
        if (!audio?.inst_storage_uri) throw new Error("Audio unavailable");
        title = audio.title;
        artist = audio.artist_name || undefined;
        duration = audio.duration ?? audio.inst_duration ?? null;
      }
      if (item.videoId) {
        const video = await getVideo(this.env, item.videoId);
        if (!video) throw new Error("Video unavailable");
        if (!title) { title = video.title; duration = video.duration; }
      }
      if (item.externalUrl) {
        const session = await resolveExternalMedia(this.env, item.externalUrl, AbortSignal.timeout(90_000));
        if (!title) { title = session.title; duration = session.duration; }
        await requestMedia(this.env, `/media/sessions/${session.id}`, { method: "DELETE" }).then((response) => response.body?.cancel()).catch(() => undefined);
      }
      const room = this.active();
      if (room.controller !== controller) return;
      const pending = room.queue.find((candidate) => candidate.id === item.id);
      if (!pending) return;
      Object.assign(pending, { title, artist, duration, status: "queued" });
      if (room.autoplay) advance(room);
      this.save(room);
    } catch {
      const room = this.read();
      if (!room || room.controller !== controller) return;
      const pending = room.queue.find((candidate) => candidate.id === item.id);
      if (!pending) return;
      pending.status = "failed";
      pending.error = "Media could not be prepared. Remove this request and try again.";
      if (room.autoplay) advance(room);
      this.save(room);
    }
  }

  private async search(initial: Room, url: URL): Promise<Response> {
    const query = (url.searchParams.get("q") || "").trim();
    if (query.length > 160) throw new RoomError("Search is too long", 400);
    const [audio, videos] = await Promise.all([
      createQueries(this.env.DB).search(query, { artistCount: 0, artistOffset: 0, albumCount: 0, albumOffset: 0, songCount: 20, songOffset: 0 }),
      listVideos(this.env, query, 0, 20),
    ]);
    if (this.active().generation !== initial.generation) throw new RoomError("Room has changed", 410);
    return Response.json({ ok: true, audio: audio.songs.filter((song) => song.inst_storage_uri).map((song) => ({ id: song.id, title: song.title, artist: song.artist_name || "", duration: song.duration ?? song.inst_duration ?? null })), videos: videos.videos });
  }

  private async links(initial: Room, url: URL): Promise<Response> {
    const audioId = url.searchParams.get("audioId");
    if (!audioId || audioId.length > 160) throw new RoomError("Choose an audio item", 400);
    const links = await this.env.DB.prepare("SELECT l.audio_id AS audioId, l.video_id AS videoId, a.title AS audioTitle, v.title AS videoTitle, l.offset_ms AS offsetMs FROM video_audio_links l JOIN song_masters a ON a.id = l.audio_id JOIN videos v ON v.id = l.video_id WHERE l.audio_id = ? LIMIT 100").bind(audioId)
      .all<{ audioId: string; videoId: string; audioTitle: string; videoTitle: string; offsetMs: number }>();
    const visible = [];
    for (const link of links.results) if (await getVideo(this.env, link.videoId)) visible.push(link);
    if (this.active().generation !== initial.generation) throw new RoomError("Room has changed", 410);
    return Response.json({ ok: true, links: visible });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 2048) { socket.close(1009, "Message too large"); return; }
    try {
      const room = this.active();
      if (!await this.enabled(room.owner)) { this.close(); return; }
      const identity = socket.deserializeAttachment() as SocketIdentity | null;
      if (!identity?.host) throw new RoomError("Use the request page", 403);
      const action = JSON.parse(message) as KtvAction;
      if (action.action !== "heartbeat" && action.action !== "playback") throw new RoomError("Unsupported socket action", 400);
      const response = await this.action(identity.participantId, action, identity.generation);
      if (!response.ok) socket.send(await response.text());
    } catch (error) {
      socket.send(JSON.stringify({ type: "error", error: error instanceof RoomError ? error.message : "Invalid message" }));
    }
  }

  async alarm(): Promise<void> {
    const room = this.read();
    if (!room) return;
    const deadline = Math.min(room.leaseUntil, room.expiresAt);
    if (deadline <= Date.now()) this.close();
    else await this.ctx.storage.setAlarm(deadline);
  }

  private async enabled(owner: string): Promise<boolean> {
    const row = await this.env.DB.prepare("SELECT s.value, u.level, u.activation_status, u.activated_until FROM user_settings s JOIN users u ON u.username = s.username WHERE s.username = ? AND s.key = 'ktv_enabled' AND u.enabled = 1 AND u.level >= 1")
      .bind(owner).first<{ value: string; level: number; activation_status: string; activated_until: number | null }>();
    if (row?.value !== "1" || !(await resolveActivation(this.env, row)).active) return false;
    return await hasPermission(this.env, row, "stream") && await hasPermission(this.env, row, "browse") && await hasPermission(this.env, row, "search");
  }
}
