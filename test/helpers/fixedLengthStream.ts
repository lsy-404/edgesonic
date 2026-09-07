export function installFixedLengthStream(): void {
  if (typeof (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream === "function") return;

  class NodeFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
    constructor(expectedLength: number | bigint) {
      const expected = Number(expectedLength);
      let actual = 0;
      super({
        transform(chunk, controller) {
          actual += chunk.byteLength;
          if (actual > expected) {
            controller.error(new Error(`FixedLengthStream length mismatch: expected ${expected} bytes, got ${actual}`));
            return;
          }
          controller.enqueue(chunk);
        },
        flush(controller) {
          if (actual !== expected) {
            controller.error(new Error(`FixedLengthStream length mismatch: expected ${expected} bytes, got ${actual}`));
          }
        },
      });
    }
  }

  Object.defineProperty(globalThis, "FixedLengthStream", {
    configurable: true,
    value: NodeFixedLengthStream,
  });
}

export async function consumeReadableStream(value: unknown): Promise<void> {
  if (!value || typeof (value as { getReader?: unknown }).getReader !== "function") return;
  const reader = (value as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) return;
  }
}
