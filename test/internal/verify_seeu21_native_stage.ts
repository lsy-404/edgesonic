import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTags } from '../../worker/src/utils/tags.ts';
import { parseFile } from 'music-metadata';

async function main() {
  const manifestPath = process.argv[2];
  assert.ok(manifestPath, 'pass the stage manifest path');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.status, 'PASS');
  assert.equal(manifest.items.length, 21);
  const results = [];
  for (const item of manifest.items) {
    const bytes = readFileSync(item.output_path);
    const parsed = parseTags(bytes.subarray(0, Math.min(bytes.length, 256 * 1024)), bytes.subarray(Math.max(0, bytes.length - 2 * 1024 * 1024)));
    assert.ok(parsed, `Worker parser rejected ${item.output_path}`);
    assert.equal(parsed.title, item.title);
    assert.equal(parsed.artist, item.artist);
    assert.equal(parsed.album, item.album);
    assert.equal(parsed.albumArtist, item.albumartist);
    assert.equal(parsed.track, item.track);
    assert.equal(parsed.year, Number(item.year));
    const metadata = await parseFile(item.output_path, { duration: true });
    assert.equal(metadata.common.title, item.title);
    assert.equal(metadata.common.artist, item.artist);
    assert.equal(metadata.common.album, item.album);
    assert.equal(metadata.common.albumartist, item.albumartist);
    assert.equal(metadata.common.track.no, item.track);
    assert.equal(metadata.common.year, Number(item.year));
    results.push({ output_path: item.output_path, worker: parsed, music_metadata: {
      title: metadata.common.title,
      artist: metadata.common.artist,
      album: metadata.common.album,
      albumartist: metadata.common.albumartist,
      track: metadata.common.track,
      year: metadata.common.year,
      duration: metadata.format.duration,
      sampleRate: metadata.format.sampleRate,
      bitsPerSample: metadata.format.bitsPerSample,
    }});
  }
  console.log(JSON.stringify({status:'PASS',count:results.length,parsers:['worker parseTags (head 256 KiB/tail 2 MiB)','music-metadata parseFile'],results}, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
