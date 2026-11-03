import assert from "node:assert/strict";
import { parseBuffer } from "music-metadata";
import { planWavRewrite } from "../../worker/src/utils/tagwrite";
import { parseTags } from "../../worker/src/utils/tags";

function chunk(id: string, body: Uint8Array) {
  const result = Buffer.alloc(8 + body.length + body.length % 2);
  result.write(id, 0, "ascii"); result.writeUInt32LE(body.length, 4); result.set(body, 8); return result;
}
function wave(...chunks: Uint8Array[]) {
  const body = Buffer.concat([Buffer.from("WAVE"), ...chunks]);
  const h = Buffer.alloc(8); h.write("RIFF"); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body]);
}
async function rewrite(data: Uint8Array, tags: any, cover?: any) {
  const plan = await planWavRewrite(data.length, async (o, n) => data.slice(o, o + n), tags, cover);
  assert(plan); return Buffer.concat(plan.parts.map(p => p instanceof Uint8Array ? p : data.slice(p.offset, p.offset + p.length)));
}
async function main() {
const fmt = Buffer.alloc(16); fmt.writeUInt16LE(1,0); fmt.writeUInt16LE(1,2); fmt.writeUInt32LE(8000,4); fmt.writeUInt32LE(16000,8); fmt.writeUInt16LE(2,12); fmt.writeUInt16LE(16,14);
const pcm = Buffer.from([1,2,3,4,5,6]);
const info = chunk("LIST", Buffer.concat([Buffer.from("INFO"), chunk("INAM", Buffer.from("Old\0")), chunk("IART", Buffer.from("Artist\0")), chunk("ICMT", Buffer.from("Keep\0"))]));
const original = wave(chunk("fmt ", fmt), info, chunk("data",pcm), chunk("JUNK",Buffer.from([7,8,9])));
const cover = { mime: "image/png", data: new Uint8Array([137,80,78,71,1,2,3]) };
const first = await rewrite(original, { title:"星尘", lyrics:"歌词内容" }, cover);
const second = await rewrite(first, { title:"新标题" });
assert.equal(parseTags(second)?.title, "新标题");
assert.equal(parseTags(second)?.artist, "Artist");
assert.equal(parseTags(second)?.lyrics, "歌词内容");
assert(second.includes(pcm)); assert(second.includes(Buffer.from("Keep\0"))); assert(second.includes(Buffer.from([7,8,9])));
const parsed = await parseBuffer(second, { path: "sample.wav" });
assert.equal(parsed.common.title, "新标题"); assert.equal(parsed.common.artist, "Artist");
assert.equal(parsed.common.picture?.[0].format, "image/png");
assert.equal(second.indexOf(Buffer.from("id3 ")), second.lastIndexOf(Buffer.from("id3 ")));
const cleared = await rewrite(second, { title: "{null}", artist: "{null}" });
assert.equal(parseTags(cleared)?.title, undefined);
assert.equal(parseTags(cleared)?.artist, undefined);
assert(!cleared.includes(Buffer.from("{null}")));
const clearedParsed = await parseBuffer(cleared, { path: "sample.wav" });
assert.equal(clearedParsed.common.title, undefined);
assert.equal(clearedParsed.common.artist, undefined);
const clearedInfoOnly = await rewrite(original, { title: "{null}", artist: "{null}" });
assert.equal(parseTags(clearedInfoOnly)?.title, undefined);
assert.equal(parseTags(clearedInfoOnly)?.artist, undefined);
assert(!clearedInfoOnly.includes(Buffer.from("{null}")));
const largeSize = 100 * 1024 * 1024;
const largeHeader = Buffer.alloc(20); largeHeader.write("RIFF"); largeHeader.writeUInt32LE(largeSize-8,4); largeHeader.write("WAVEdata",8); largeHeader.writeUInt32LE(largeSize-20,16);
let maxRead = 0;
const large = await planWavRewrite(largeSize, async (o,n) => { maxRead = Math.max(maxRead,n); return largeHeader.subarray(o,o+n); }, { title:"Large" });
assert(large); assert(maxRead <= 12); assert(large.parts.some(p => !(p instanceof Uint8Array) && p.length > 80*1024*1024));
assert.equal(await planWavRewrite(original.length-1, async (o,n) => original.slice(o,o+n), {}), null);
console.log("WAV rewrite: passed");

}
main().catch(error => { console.error(error); process.exitCode = 1; });
