import { copyR2Object } from "../../worker/src/utils/r2ObjectCopy";
import { installFixedLengthStream } from "../helpers/fixedLengthStream";

installFixedLengthStream();

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

interface Item { body: Uint8Array; contentType: string }

function makeBucket() {
  const store = new Map<string, Item>();
  let puts = 0;
  return {
    store,
    get puts() { return puts; },
    async get(key: string) {
      const item = store.get(key);
      if (!item) return null;
      return {
        key,
        size: item.body.byteLength,
        body: new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(item.body); controller.close(); },
        }),
        httpMetadata: { contentType: item.contentType },
        customMetadata: {},
      };
    },
    async put(key: string, body: unknown, opts?: { httpMetadata?: { contentType?: string } }) {
      puts++;
      const reader = (body as ReadableStream<Uint8Array>).getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
        total += next.value.byteLength;
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      store.set(key, { body: bytes, contentType: opts?.httpMetadata?.contentType || "application/octet-stream" });
    },
  };
}

async function main() {
  const bucket = makeBucket();
  bucket.store.set("objects/source.mp3", { body: new Uint8Array([7, 8, 9]), contentType: "audio/mpeg" });
  const copied = await copyR2Object({ MUSIC_BUCKET: bucket as unknown as R2Bucket }, "objects/source.mp3", "objects/dest.mp3");
  assert(copied, "binding copy succeeds without a second credential pair");
  assert(bucket.puts === 1, "one fixed-length binding PUT is used");
  assert(Array.from(bucket.store.get("objects/dest.mp3")?.body || []).join(",") === "7,8,9", "copy preserves bytes");

  console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) FAILED.`);
  if (failures) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
