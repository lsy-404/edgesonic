import { beginRequest } from "./netDiag";

export const READ_REQUEST_TIMEOUT_MS = 20_000;
export const WRITE_REQUEST_TIMEOUT_MS = 60_000;

export class RequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`request timed out after ${timeoutMs} ms`);
    this.name = "TimeoutError";
  }
}

export interface TimedTextResponse {
  response: Response;
  text: string;
}

function diagnosticUrl(input: RequestInfo | URL): string {
  const raw = input instanceof Request ? input.url : String(input);
  try {
    const url = new URL(raw, typeof location === "undefined" ? "https://request.invalid" : location.href);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "(invalid request)";
  }
}

export async function fetchTextWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = READ_REQUEST_TIMEOUT_MS,
): Promise<TimedTextResponse> {
  const controller = new AbortController();
  const sourceSignals = [input instanceof Request ? input.signal : undefined, init.signal].filter(Boolean) as AbortSignal[];
  const abortFromCaller = (signal: AbortSignal) => () => controller.abort(signal.reason);
  const abortListeners = sourceSignals.map((signal) => [signal, abortFromCaller(signal)] as const);
  for (const [signal, listener] of abortListeners) {
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new RequestTimeoutError(timeoutMs)), timeoutMs);
  const diagnostic = beginRequest(`api ${init.method || "GET"}`, diagnosticUrl(input));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    diagnostic.headers(response.status);
    if (!response.body) {
      const text = await response.text();
      diagnostic.progress(new TextEncoder().encode(text).byteLength);
      diagnostic.end({ status: response.status });
      return { response, text };
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        const complete = text + decoder.decode();
        diagnostic.end({ status: response.status });
        return { response, text: complete };
      }
      received += value.byteLength;
      diagnostic.progress(received);
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (!controller.signal.aborted) controller.abort(error);
    diagnostic.fail(error);
    throw error;
  } finally {
    reader?.releaseLock();
    clearTimeout(timer);
    for (const [signal, listener] of abortListeners) signal.removeEventListener("abort", listener);
  }
}
