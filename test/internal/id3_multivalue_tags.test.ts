import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseTags } from "../../worker/src/utils/tags";

function syncsafe(value: number): number[] {
  return [(value >>> 21) & 0x7f, (value >>> 14) & 0x7f, (value >>> 7) & 0x7f, value & 0x7f];
}

function frame(id: string, values: string[]): number[] {
  const body = [3, ...new TextEncoder().encode(values.join("\0"))];
  return [
    ...new TextEncoder().encode(id),
    ...syncsafe(body.length),
    0, 0,
    ...body,
  ];
}

function id3v24(...frames: number[][]): Uint8Array {
  const body = frames.flat();
  return new Uint8Array([
    0x49, 0x44, 0x33, 4, 0, 0,
    ...syncsafe(body.length),
    ...body,
    0xff, 0xfb, 0x90, 0x00,
  ]);
}

test("ID3v2.4 text-frame multivalues become readable credits without NUL", () => {
  const tags = parseTags(id3v24(
    frame("TPE1", ["Artist One", "Artist Two"]),
    frame("TPE2", ["Album Artist One", "Album Artist Two"]),
  ));

  assert.equal(tags?.artist, "Artist One / Artist Two");
  assert.equal(tags?.albumArtist, "Album Artist One / Album Artist Two");
  assert.ok(!tags?.artist?.includes("\0"));
  assert.ok(!tags?.albumArtist?.includes("\0"));
});

const realFixtureDir = process.env.ID3_MULTIVALUE_FIXTURE_DIR;
if (realFixtureDir) {
  test("real merged WAV fixtures expose scalar artist credits to the Worker parser", () => {
    const names = ["Q4-T01", "Q4-T02", ...Array.from({ length: 9 }, (_, index) => `Q5-T${String(index + 1).padStart(2, "0")}`)];
    for (const name of names) {
      const bytes = fs.readFileSync(path.join(realFixtureDir, `${name}-final.wav`));
      const head = new Uint8Array(bytes.subarray(0, 128 * 1024));
      const tail = new Uint8Array(bytes.subarray(Math.max(0, bytes.length - 2 * 1024 * 1024)));
      const tags = parseTags(head, tail);
      assert.ok(tags?.artist, `${name} should have an artist`);
      assert.ok(tags?.albumArtist, `${name} should have an album artist`);
      assert.ok(!tags.artist.includes("\0"), `${name} artist should not contain NUL`);
      assert.ok(!tags.albumArtist.includes("\0"), `${name} album artist should not contain NUL`);
      if (name.startsWith("Q5-")) {
        assert.equal(tags.albumArtist, "乐正绫 / 星尘 / 洛天依", `${name} should have deduplicated album artist names`);
      }
    }
  });
}
