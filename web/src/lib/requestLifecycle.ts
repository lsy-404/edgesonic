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
    return raw.split("?")[0];
  }
}

export async function fetchTextWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = READ_REQUEST_TIMEOUT_MS,
): Promise<TimedTextResponse> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abortFromCaller();
  else init.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(new RequestTimeoutError(timeoutMs)), timeoutMs);
  const diagnostic = beginRequest(`api ${init.method || "GET"}`, diagnosticUrl(input));
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    diagnostic.progress(0);
    if (!response.body) {
      const text = await response.text();
      diagnostic.progress(new TextEncoder().encode(text).byteLength);
      diagnostic.end({ status: response.status });
      return { response, text };
    }
    const reader = response.body.getReader();
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
    diagnostic.fail(error);
    throw error;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abortFromCaller);
  }
}
import { beginRequest } from "./netDiag";
