// Transport probe: measures how a held-open request can be joined with a
// pushed job on a connected agent, and how the agent's bytes get back.
//
// Three combinations under test:
//   ws     — WebSocket control + WebSocket binary frames back
//   sse    — SSE control + sequential chunked POSTs back
//   sse1   — SSE control + one streaming POST back
//
// Routes (all forwarded to a single Relay instance):
//   GET  /agent/ws                 agent joins over WebSocket
//   GET  /agent/sse                agent joins over SSE
//   POST /push?job=&seq=&fin=      chunked return path (sse)
//   POST /pushStream?job=          streaming return path (sse1)
//   GET  /pull?mode=&bytes=&chunk= requester; holds until bytes arrive
//   GET  /stats                    connected agent counts

interface Env {
  RELAY: DurableObjectNamespace;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const id = env.RELAY.idFromName("probe");
    return env.RELAY.get(id).fetch(req);
  },
};

interface Job {
  controller: ReadableStreamDefaultController<Uint8Array>;
  // Chunked mode can deliver out of order; buffer until the gap fills.
  nextSeq: number;
  buffered: Map<number, Uint8Array>;
  closed: boolean;
}

export class Relay implements DurableObject {
  private sseAgents = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  private jobs = new Map<string, Job>();
  private rr = 0;
  private encoder = new TextEncoder();

  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/agent/ws": return this.agentWs();
      case "/agent/sse": return this.agentSse();
      case "/push": return this.push(req, url);
      case "/pushStream": return this.pushStream(req, url);
      case "/pull": return this.pull(url);
      case "/stats": return this.stats();
      default: return new Response("not found", { status: 404 });
    }
  }

  // --- agent side ---------------------------------------------------------

  private agentWs(): Response {
    const pair = new WebSocketPair();
    // Hibernation API — what a production coordinator would use, so the probe
    // measures the same code path rather than a plain accept().
    this.state.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private agentSse(): Response {
    const agentId = crypto.randomUUID();
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.sseAgents.set(agentId, controller);
        controller.enqueue(this.encoder.encode(`event: ready\ndata: {"agentId":"${agentId}"}\n\n`));
      },
      cancel: () => { this.sseAgents.delete(agentId); },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "Connection": "keep-alive",
      },
    });
  }

  // Binary frames arrive here in ws mode. The first text frame a job produces
  // is its header so we know which job the following binary frames belong to.
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string") {
      const msg = JSON.parse(message) as { type: string; job?: string };
      if (msg.type === "bind" && msg.job) {
        // Remember the job this socket is currently streaming for.
        ws.serializeAttachment({ job: msg.job });
      } else if (msg.type === "fin" && msg.job) {
        this.finish(msg.job);
      }
      return;
    }
    const attach = ws.deserializeAttachment() as { job?: string } | null;
    if (!attach?.job) return;
    const job = this.jobs.get(attach.job);
    if (!job || job.closed) return;
    job.controller.enqueue(new Uint8Array(message));
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attach = ws.deserializeAttachment() as { job?: string } | null;
    if (attach?.job) this.finish(attach.job);
  }

  // Chunked return path — one request per chunk, may arrive out of order.
  private async push(req: Request, url: URL): Promise<Response> {
    const jobId = url.searchParams.get("job") || "";
    const seq = parseInt(url.searchParams.get("seq") || "0", 10);
    const fin = url.searchParams.get("fin") === "1";
    const job = this.jobs.get(jobId);
    if (!job) return new Response("unknown job", { status: 404 });
    const body = new Uint8Array(await req.arrayBuffer());
    job.buffered.set(seq, body);
    while (job.buffered.has(job.nextSeq)) {
      const chunk = job.buffered.get(job.nextSeq)!;
      job.buffered.delete(job.nextSeq);
      job.nextSeq++;
      if (!job.closed) job.controller.enqueue(chunk);
    }
    if (fin) this.finish(jobId);
    return new Response("ok");
  }

  // Streaming return path — one request whose body is consumed as it arrives.
  private async pushStream(req: Request, url: URL): Promise<Response> {
    const jobId = url.searchParams.get("job") || "";
    const job = this.jobs.get(jobId);
    if (!job || !req.body) return new Response("unknown job", { status: 404 });
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && !job.closed) job.controller.enqueue(value);
    }
    this.finish(jobId);
    return new Response("ok");
  }

  private finish(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job || job.closed) return;
    job.closed = true;
    try { job.controller.close(); } catch { /* already closed */ }
    this.jobs.delete(jobId);
  }

  // --- requester side -----------------------------------------------------

  private pull(url: URL): Response {
    const mode = url.searchParams.get("mode") || "ws";
    // Control channel and return path vary independently: an SSE control
    // channel can hand its bytes back three different ways.
    const ret = url.searchParams.get("ret") || mode;
    const bytes = parseInt(url.searchParams.get("bytes") || "1048576", 10);
    const chunk = parseInt(url.searchParams.get("chunk") || "65536", 10);
    const jobId = crypto.randomUUID();

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.jobs.set(jobId, { controller, nextSeq: 0, buffered: new Map(), closed: false });
        // Dispatch immediately — this is the latency the whole design exists
        // to minimise, so nothing may be awaited before it.
        const job = JSON.stringify({ type: "job", job: jobId, bytes, chunk, ret });
        if (mode === "ws") {
          // getWebSockets() can still hand back a socket that is closing or
          // already gone. Dispatching to one strands the held request forever,
          // so filter on readyState before picking.
          const sockets = this.state.getWebSockets().filter((s) => s.readyState === 1);
          if (sockets.length === 0) { controller.error(new Error("no ws agent")); return; }
          sockets[this.rr++ % sockets.length].send(job);
        } else {
          const ids = [...this.sseAgents.keys()];
          if (ids.length === 0) { controller.error(new Error("no sse agent")); return; }
          const target = this.sseAgents.get(ids[this.rr++ % ids.length])!;
          target.enqueue(this.encoder.encode(`event: job\ndata: ${job}\n\n`));
        }
      },
    });

    return new Response(stream, {
      headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
    });
  }

  private stats(): Response {
    return Response.json({
      ws: this.state.getWebSockets().length,
      sse: this.sseAgents.size,
      jobs: this.jobs.size,
    });
  }
}
