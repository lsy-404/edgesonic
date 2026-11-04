import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseBuffer } from "music-metadata";
import { planMp4Rewrite } from "../../worker/src/utils/mp4Tagwrite";

function run(command: string, args: string[]): Buffer {
  const p = spawnSync(command, args, { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(p.status, 0, p.stderr?.toString()); return p.stdout;
}
async function rewrite(bytes: Uint8Array, tags: any, cover?: any) {
  const plan = await planMp4Rewrite(bytes.length, async (offset, length) => bytes.slice(offset, offset + length), tags, cover);
  assert(plan, "valid MP4 accepted");
  return Buffer.concat(plan.parts.map(p => p instanceof Uint8Array ? p : bytes.slice(p.offset, p.offset + p.length)));
}
function box(type: string, ...body: Uint8Array[]) {
  const data = Buffer.concat(body), out = Buffer.alloc(data.length + 8);
  out.writeUInt32BE(out.length); out.write(type, 4, 4, "latin1"); out.set(data, 8); return out;
}
function offsets(bytes: Buffer, type: string): number {
  const index = bytes.indexOf(Buffer.from(type)); assert(index > 0);
  return type === "co64" ? Number(bytes.readBigUInt64BE(index + 12)) : bytes.readUInt32BE(index + 12);
}
async function main() {
  const dir = mkdtempSync(resolve("test", ".mp4-tagwrite-"));
  try {
    const cover = { mime: "image/png", data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64") };
    for (const [codec, fast] of [["aac", false], ["alac", true]] as const) {
      const source = join(dir, `${codec}.m4a`), out = join(dir, `${codec}-out.m4a`);
      run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=400:duration=0.4", "-c:a", codec, "-metadata", "title=Original", "-metadata", "comment=retain custom metadata", "-metadata", "track=2/9", "-metadata", "disc=1/3", ...(fast ? ["-movflags", "+faststart"] : []), "-y", source]);
      const original = readFileSync(source);
      const first = await rewrite(original, { title: "星尘", artist: "歌手", albumArtist: "专辑艺人", album: "唱片", year: 2025, genre: "流行", lyrics: "歌词内容", track: 4, disc: 2 }, cover);
      const second = await rewrite(first, { title: "新的标题" });
      const third = await rewrite(second, { title: "新的标题" });
      assert.equal(second.length, third.length, "repeated writes stay stable");
      writeFileSync(out, third);
      const info = await parseBuffer(third, { path: out });
      assert.equal(info.common.title, "新的标题"); assert.equal(info.common.artist, "歌手");
      assert.equal(info.common.albumartist, "专辑艺人"); assert.equal(info.common.album, "唱片");
      assert.deepEqual(info.common.track, { no: 4, of: 9 }); assert.deepEqual(info.common.disk, { no: 2, of: 3 });
      assert.equal(info.common.picture?.[0].format, "image/png");
      const probe = JSON.parse(run("ffprobe", ["-v", "error", "-show_format", "-of", "json", out]).toString());
      assert.equal(probe.format.tags.title, "新的标题");
      assert.equal(probe.format.tags.comment, "retain custom metadata");
      assert.equal(probe.format.tags.lyrics, "歌词内容");
      const pcm = (path: string) => run("ffmpeg", ["-v", "error", "-i", path, "-map", "0:a:0", "-f", "s16le", "-"]);
      assert.deepEqual(pcm(out), pcm(source), "decoded audio unchanged");
      const cleared = await rewrite(third, { title: "{null}" });
      assert.equal((await parseBuffer(cleared, { path: out })).common.title, undefined);
    }
    for (const kind of ["stco", "co64"]) {
      const ftyp = box("ftyp", Buffer.from("M4A \0\0\0\0M4A "));
      const table = Buffer.alloc(kind === "stco" ? 12 : 16); table.writeUInt32BE(1, 4);
      const makeMoov = () => box("moov", box("trak", box("mdia", box("minf", box("stbl", box(kind, table))))));
      let moov = makeMoov();
      const offset = ftyp.length + moov.length + 8;
      if (kind === "stco") table.writeUInt32BE(offset, 8); else table.writeBigUInt64BE(BigInt(offset), 8);
      moov = makeMoov();
      const source = Buffer.concat([ftyp, moov, box("mdat", Buffer.from([1, 2, 3, 4]))]);
      const result = await rewrite(source, {title: "Test"});
      assert.equal(offsets(result, kind), result.indexOf(Buffer.from("mdat")) + 4);
    }
    assert.equal(await planMp4Rewrite(12, async () => Buffer.from("0000broken!!"), {}), null);
    console.log("MP4 tag rewrite passed");
  } finally { for (const file of readdirSync(dir)) unlinkSync(join(dir, file)); rmdirSync(dir); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
