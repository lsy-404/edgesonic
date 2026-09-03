export class PayloadTooLargeError extends Error {
  constructor() {
    super("Payload too large");
    this.name = "PayloadTooLargeError";
  }
}

export function limitReadableStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  onComplete?: () => void,
  onOverflow?: () => void,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        onOverflow?.();
        controller.error(new PayloadTooLargeError());
        return;
      }
      controller.enqueue(chunk);
    },
    flush() {
      onComplete?.();
    },
  }));
}
