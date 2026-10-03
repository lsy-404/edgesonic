import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { locateEmbeddedPicture, parseTags } from "../../worker/src/utils/tags.ts";

const require = createRequire(process.env.YEQ_REQUIRE_BASE ?? import.meta.url);
const { parseFile } = require("music-metadata") as typeof import("music-metadata");

type ManifestItem = {
  object_id: string;
  local_file: string;
  size: number;
  md5: string;
  sha256: string;
};

const opsDir = process.env.YEQ_AUDIT_DIR;
assert.ok(opsDir, "YEQ_AUDIT_DIR is required");
const manifestPath = resolve(opsDir, "yequ_wav_native_union_upload_manifest_v2.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { items: ManifestItem[] };
assert.equal(manifest.items.length, 12);
const titles = [
  "夏日未应答", "名無しの油絵", "星球卑", "南风", "海风以北", "在云端提着花洒的女孩",
  "在路上", "ナルキッソス", "线条与色彩", "再开启", "对你说", "另一世界的你",
];
const proof: unknown[] = [];

async function main(): Promise<void> {
for (let index = 0; index < manifest.items.length; index += 1) {
  const item = manifest.items[index];
  const bytes = readFileSync(item.local_file);
  assert.equal(bytes.length, item.size);
  assert.equal(createHash("md5").update(bytes).digest("hex"), item.md5);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256);
  const head = bytes.subarray(0, 256 * 1024);
  const tail = bytes.subarray(Math.max(0, bytes.length - 2 * 1024 * 1024));
  const worker = parseTags(head, tail);
  const workerPicture = locateEmbeddedPicture(head, tail);
  const expected = {
    title: titles[index], artist: "洛天依", album: "遇依", albumArtist: "洛天依", year: 2024, track: index + 1, disc: 1,
  };
  assert.deepEqual(worker, expected, `Worker parseTags result for track ${index + 1}`);
  const parsed = await parseFile(item.local_file);
  assert.equal(parsed.common.title, expected.title);
  assert.equal(Array.isArray(parsed.common.artist) ? parsed.common.artist.join(" / ") : parsed.common.artist, expected.artist);
  assert.equal(parsed.common.album, expected.album);
  assert.equal(parsed.common.albumartist, expected.albumArtist);
  assert.equal(parsed.common.year, expected.year);
  assert.equal(parsed.common.track.no, expected.track);
  assert.equal(parsed.common.track.of, 12);
  assert.equal(parsed.format.sampleRate, 48000);
  assert.equal(parsed.format.bitsPerSample, 24);
  assert.equal(parsed.format.numberOfChannels, 2);
  const sourceCopy = parsed.native?.["ID3v2.4"]?.find((entry) => entry.id === "TXXX:SOURCE_COPY");
  assert.ok(sourceCopy, `SOURCE_COPY native frame for track ${index + 1}`);
  const lowerSourceCopy = parsed.native?.["ID3v2.4"]?.find((entry) => entry.id === "TXXX:SOURCE_COPY_LOWER_FLAC_JSON");
  assert.ok(lowerSourceCopy, `lower FLAC SOURCE_COPY frame for track ${index + 1}`);
  const lowerCopy = JSON.parse(String(lowerSourceCopy.value)) as { comments: Record<string, string[]>; pictures: Array<{ sha256: string }> };
  assert.equal(lowerCopy.comments.album?.[0], "未知标题");
  assert.equal(lowerCopy.comments.albumartist?.[0], "未知艺术家");
  assert.equal(lowerCopy.pictures.length, 1);
  assert.ok(workerPicture, `Worker embedded picture location for track ${index + 1}`);
  assert.equal(workerPicture.source, "tail");
  assert.equal(createHash("sha256").update(tail.subarray(workerPicture.offset, workerPicture.offset + workerPicture.length)).digest("hex"), lowerCopy.pictures[0].sha256);
  const mmPictures = parsed.common.picture ?? [];
  assert.equal(mmPictures.length, 1);
  assert.equal(createHash("sha256").update(mmPictures[0].data).digest("hex"), lowerCopy.pictures[0].sha256);
  proof.push({
    track: index + 1,
    object_id: item.object_id,
    worker_parseTags: worker,
    music_metadata: {
      title: parsed.common.title,
      artist: parsed.common.artist,
      album: parsed.common.album,
      albumartist: parsed.common.albumartist,
      year: parsed.common.year,
      track: parsed.common.track,
      sampleRate: parsed.format.sampleRate,
      bitsPerSample: parsed.format.bitsPerSample,
      channels: parsed.format.numberOfChannels,
      id3_version: parsed.format.tagTypes,
      source_copy_found: true,
      source_copy_lower_flac_comments: lowerCopy.comments,
      embedded_picture_sha256: lowerCopy.pictures[0].sha256,
      worker_picture_extraction_source: workerPicture.source,
    },
  });
}

const output = {
  status: "PASS",
  item_count: proof.length,
  worker_parser: "worker/src/utils/tags.ts parseTags with production 256 KiB head and 2 MiB tail windows",
  full_file_parser: "music-metadata parseFile",
  items: proof,
};
const outPath = resolve(opsDir, "yequ_wav_native_union_worker_parser_proof_v2.json");
writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ status: output.status, item_count: output.item_count, proof: outPath }));
}

void main();
