// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// Rendezvous point between newly queued work and the browsers that can run it.
//
// Only the dispatch direction travels over the socket. Results still go back
// through POST /work/submit, which owns the cascade into song_masters,
// cover writes and retry/terminal bookkeeping — none of that is duplicated
// here, so this stays a thin router.
//
// Three rules learned from measuring this before building it:
//  - never dispatch to a socket that isn't OPEN. A task handed to a dead
//    socket is claimed but never runs, so it sits until the reclaim sweep.
//  - dispatch on every edge that can change the answer: a new row arriving,
//    an agent joining, a slot freeing, a budget or capability changing. This
//    is the only mechanism now, so an edge that doesn't dispatch is a stall.
//  - when an agent goes away, put its rows back here rather than waiting for
//    the TTL sweep. A vanished browser is the common case, not the exception.
//
// Agent state lives in each socket's attachment rather than an instance field
// so it survives hibernation: an idle pool of connected browsers costs
// nothing until work actually shows up.

import { getFeatureString } from "../utils/features";

// What a browser tells us when it joins, and what we track per socket.
interface AgentState {
  username: string;
  caps: string[];
  // How many tasks this browser is willing to run at once.
  maxConcurrent: number;
  // The task ids currently with this agent. Tracked by id rather than a bare
  // count so a disconnect can put exactly those rows back; its length is the
  // authoritative in-flight number, since the agent acknowledges each
  // completion and a browser that silently drops one can't leak capacity.
  holding: string[];
  joinedAt: number;
}

interface DispatchOutcome {
  dispatched: number;
  agents: number;
}

// Ping/pong is configured through setWebSocketAutoResponse so the runtime
// answers keepalives without waking a hibernating object.
const PING = "ping";
const PONG = "pong";

export class WorkCoordinator implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(PING, PONG),
    );
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/join": return this.join(req);
      case "/notify": return this.notify();
      case "/agents": return this.agents();
      default: return new Response("not found", { status: 404 });
    }
  }

  // --- agent lifecycle ------------------------------------------------------

  private async join(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const username = req.headers.get("X-Agent-User") || "";
    if (!username) return new Response("missing agent identity", { status: 400 });
    const caps = (req.headers.get("X-Agent-Caps") || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const maxConcurrent = clampInt(
      parseInt(req.headers.get("X-Agent-Concurrency") || "1", 10), 1, 8,
    );

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    const agent: AgentState = {
      username, caps, maxConcurrent, holding: [],
      joinedAt: Math.floor(Date.now() / 1000),
    };
    pair[1].serializeAttachment(agent);
    pair[1].send(JSON.stringify({ type: "welcome", maxConcurrent }));

    // Hand this agent whatever is already queued before returning. Without
    // this, a browser joining an existing backlog — rows the reclaim sweep
    // put back, or a scan that ran while nobody was connected — sits idle
    // until some unrelated enqueue happens to fire dispatch.
    //
    // Deliberately awaited rather than fired and forgotten: dispatch does D1
    // I/O, and once the 101 has been returned there is no request left to
    // anchor that work to. Sending on the socket before returning is fine —
    // the welcome frame above takes the same path.
    await this.dispatch();

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    let msg: { type?: string; id?: string; caps?: string[]; maxConcurrent?: number };
    try { msg = JSON.parse(raw); } catch { return; }
    const agent = ws.deserializeAttachment() as AgentState | null;
    if (!agent) return;

    switch (msg.type) {
      case "done":
        // The agent finished with this task — succeeded, failed or abandoned;
        // /work/submit already recorded which. All that matters here is that
        // the slot is free. Dropping by id makes a duplicate ack a no-op
        // instead of manufacturing capacity the browser doesn't have.
        if (msg.id) agent.holding = agent.holding.filter((id) => id !== msg.id);
        ws.serializeAttachment(agent);
        // Freed capacity is the cheapest moment to look for more work.
        await this.dispatch();
        break;
      case "config":
        if (Array.isArray(msg.caps)) agent.caps = msg.caps.filter((c) => typeof c === "string");
        if (msg.maxConcurrent !== undefined) {
          agent.maxConcurrent = clampInt(msg.maxConcurrent, 1, 8);
        }
        ws.serializeAttachment(agent);
        // A raised ceiling or a widened capability set can make work that was
        // previously unassignable assignable right now.
        await this.dispatch();
        break;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.releaseHeld(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.releaseHeld(ws);
  }

  // Put back whatever this agent was holding when it went away. The claim TTL
  // sweep would eventually do this, but it runs on the cron and the browser
  // that vanished is the common case — a closed laptop, a killed tab. Doing
  // it here turns a wait of up to an hour into a wait of milliseconds.
  private async releaseHeld(ws: WebSocket): Promise<void> {
    const agent = ws.deserializeAttachment() as AgentState | null;
    try { ws.close(); } catch { /* already closing */ }
    if (!agent?.holding.length) return;

    // The attempt is un-burned: the task never ran to a verdict, so charging
    // it one of its retries would punish it for this browser's disconnect.
    for (const id of agent.holding) {
      try {
        await this.env.DB.prepare(
          `UPDATE work_queue
              SET status = 'queued', claimed_by = NULL, claimed_at = NULL,
                  heartbeat_at = NULL, attempts = MAX(0, attempts - 1)
            WHERE id = ? AND status = 'claimed' AND claimed_by = ?`,
        ).bind(id, agent.username).run();
      } catch (e) {
        // Leave it to the sweep rather than abandoning the remaining ids.
        console.error(`[coordinator] release failed for ${id}:`, e);
      }
    }
    agent.holding = [];
    try { ws.serializeAttachment(agent); } catch { /* socket already gone */ }
    // Those rows are queued again and somebody else may be idle.
    await this.dispatch();
  }

  // --- dispatch -------------------------------------------------------------

  // Called after rows land in work_queue. Claims on behalf of whichever agents
  // have spare capacity and pushes the tasks straight down their sockets.
  private async notify(): Promise<Response> {
    const outcome = await this.dispatch();
    return Response.json({ ok: true, ...outcome });
  }

  private async agents(): Promise<Response> {
    const list = this.liveAgents().map(({ agent }) => ({
      username: agent.username,
      caps: agent.caps,
      maxConcurrent: agent.maxConcurrent,
      inFlight: agent.holding.length,
      joinedAt: agent.joinedAt,
    }));
    return Response.json({ ok: true, agents: list });
  }

  // Sockets that are actually OPEN, paired with their decoded state. Every
  // dispatch path goes through here rather than raw getWebSockets().
  private liveAgents(): Array<{ ws: WebSocket; agent: AgentState }> {
    const out: Array<{ ws: WebSocket; agent: AgentState }> = [];
    for (const ws of this.state.getWebSockets()) {
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const agent = ws.deserializeAttachment() as AgentState | null;
      if (agent) out.push({ ws, agent });
    }
    return out;
  }

  private async dispatch(): Promise<DispatchOutcome> {
    const live = this.liveAgents();
    if (live.length === 0) return { dispatched: 0, agents: 0 };

    // Re-read the kill-switch on every dispatch, not just at connect time.
    // An admin flipping worker_pool_enabled off has to be able to stop a
    // fleet that is already connected, not just prevent new arrivals.
    if ((await getFeatureString(this.env, "worker_pool_enabled", "1")) === "0") {
      return { dispatched: 0, agents: live.length };
    }

    // Total headroom across the pool bounds how many rows we even look at.
    let headroom = 0;
    for (const { agent } of live) {
      headroom += Math.max(0, agent.maxConcurrent - agent.holding.length);
    }
    if (headroom === 0) return { dispatched: 0, agents: live.length };

    // Read a candidate window once, then hand rows out. Claiming is still the
    // atomic UPDATE ... RETURNING used by the poll path, so a browser that
    // polls and one that is pushed to can never receive the same row.
    const candidates = (await this.env.DB.prepare(
      `SELECT id, required_caps
         FROM work_queue
        WHERE status = 'queued'
        ORDER BY priority ASC, created_at ASC
        LIMIT ?`,
    ).bind(Math.min(headroom * 2, 64)).all<{ id: string; required_caps: string | null }>()).results;

    let dispatched = 0;
    for (const row of candidates) {
      const required = parseCaps(row.required_caps);
      const target = live.find(({ agent }) =>
        agent.holding.length < agent.maxConcurrent && capsSatisfy(agent.caps, required),
      );
      if (!target) continue;

      const claimed = await this.env.DB.prepare(
        `UPDATE work_queue
            SET status = 'claimed', claimed_by = ?, claimed_at = unixepoch(),
                heartbeat_at = unixepoch(), attempts = attempts + 1
          WHERE id = ? AND status = 'queued'
          RETURNING id, task_type, payload, required_caps, priority,
                    attempts, max_attempts, claimed_at, heartbeat_at`,
      ).bind(target.agent.username, row.id).first<{
        id: string;
        task_type: string;
        payload: string;
        required_caps: string | null;
        priority: number;
        attempts: number;
        max_attempts: number;
        claimed_at: number;
        heartbeat_at: number;
      }>();
      if (!claimed) continue;    // a poller beat us to it

      const task = {
        id: claimed.id,
        taskType: claimed.task_type,
        payload: safeJsonParse(claimed.payload),
        requiredCaps: parseCaps(claimed.required_caps),
        priority: claimed.priority,
        attempts: claimed.attempts,
        maxAttempts: claimed.max_attempts,
        claimedAt: claimed.claimed_at,
        heartbeatAt: claimed.heartbeat_at,
      };
      try {
        target.ws.send(JSON.stringify({ type: "task", task }));
      } catch {
        // The socket died between the readyState check and the send. Put the
        // row straight back rather than waiting on the reclaim sweep.
        await this.env.DB.prepare(
          `UPDATE work_queue
              SET status = 'queued', claimed_by = NULL, claimed_at = NULL,
                  heartbeat_at = NULL, attempts = MAX(0, attempts - 1)
            WHERE id = ? AND status = 'claimed'`,
        ).bind(claimed.id).run();
        continue;
      }
      target.agent.holding.push(claimed.id);
      target.ws.serializeAttachment(target.agent);
      dispatched++;
    }

    return { dispatched, agents: live.length };
  }
}

// ---------------------------------------------------------------------------
// Helpers — kept local so the DO module has no import cycle with work.ts.
// ---------------------------------------------------------------------------

function parseCaps(raw: string | null | undefined): string[] {
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((s): s is string => typeof s === "string" && s.length > 0);
      }
    } catch { /* fall through */ }
    return [];
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function capsSatisfy(callerCaps: string[], required: string[]): boolean {
  if (required.length === 0) return true;
  const have = new Set(callerCaps);
  return required.every((cap) => have.has(cap));
}

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

// Wakes the coordinator after rows are inserted. Best-effort by design: if the
// object is unreachable the rows are still queued and the poll path picks them
// up on its next cycle.
export async function notifyCoordinator(env: Env): Promise<void> {
  if (!env.WORK_COORDINATOR) return;
  const id = env.WORK_COORDINATOR.idFromName("pool");
  await env.WORK_COORDINATOR.get(id).fetch("https://coordinator/notify");
}
