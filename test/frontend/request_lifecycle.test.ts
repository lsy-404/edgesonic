import { fetchTextWithTimeout, RequestTimeoutError } from "../../web/src/lib/requestLifecycle";
import { createServer } from "node:http";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

async function rejects(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error("expected rejection");
}

async function run() {
  const originalFetch = globalThis.fetch;
  try {
    let headerSignal: AbortSignal | undefined;
    globalThis.fetch = ((_input, init) => new Promise((_, reject) => {
      headerSignal = init?.signal ?? undefined;
      headerSignal?.addEventListener("abort", () => reject(headerSignal?.reason), { once: true });
    })) as typeof fetch;
    const headerError = await rejects(fetchTextWithTimeout("/headers", {}, 10));
    assert(headerSignal?.aborted, "header timeout aborts the active fetch signal");
    assert(headerError instanceof RequestTimeoutError, "header timeout settles with a timeout error");

    let bodySignal: AbortSignal | undefined;
    globalThis.fetch = ((_input, init) => {
      bodySignal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
          bodySignal?.addEventListener("abort", () => controller.error(bodySignal?.reason), { once: true });
        },
      });
      return Promise.resolve(new Response(body));
    }) as typeof fetch;
    const bodyError = await rejects(fetchTextWithTimeout("/body", {}, 10));
    assert(bodySignal?.aborted, "body timeout aborts the same fetch signal");
    assert(bodyError instanceof RequestTimeoutError, "body timeout settles while the reader is stalled");

    const caller = new AbortController();
    globalThis.fetch = ((_input, init) => new Promise((_, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;
    const pending = fetchTextWithTimeout("/caller", { signal: caller.signal }, 1_000);
    caller.abort(new DOMException("view closed", "AbortError"));
    const callerError = await rejects(pending);
    assert(callerError instanceof DOMException && callerError.name === "AbortError", "caller cancellation settles without waiting for the deadline");

    globalThis.fetch = originalFetch;
    const server = createServer((request, response) => {
      if (request.url === "/body") response.write("partial");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    const realHeaderError = await rejects(fetchTextWithTimeout(`${base}/headers`, {}, 20));
    const realBodyError = await rejects(fetchTextWithTimeout(`${base}/body`, {}, 20));
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort(new DOMException("closed", "AbortError"));
    const preCancelledError = await rejects(fetchTextWithTimeout(`${base}/headers`, { signal: alreadyCancelled.signal }, 20));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert(realHeaderError instanceof RequestTimeoutError, "real HTTP headers stall is aborted");
    assert(realBodyError instanceof RequestTimeoutError, "real HTTP body stall is aborted");
    assert(preCancelledError instanceof DOMException && preCancelledError.name === "AbortError", "pre-cancelled real request settles immediately");
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

run().catch((error) => { console.error(error); process.exit(1); });
