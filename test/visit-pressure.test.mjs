import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { parseVisitOptions, runVisitPressure } from './pressure-baseline/visit-pressure.mjs';

const xml = '<subsonic-response status="ok" version="1.16.1"><artist id="pressure-artist-000"/><album id="pressure-album-000"/><song id="pressure-song-00000"/><artistInfo/><searchResult3><song id="pressure-song-00000"/></searchResult3><lyricsList><structuredLyrics><line>fixture</line></structuredLyrics></lyricsList><playlists><playlist id="fixture-playlist"/></playlists></subsonic-response>';

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('accepts only bounded HTTP loopback origins and synthetic visitor counts', () => {
  assert.throws(() => parseVisitOptions(['--base-url=https://127.0.0.1']), /loopback/);
  assert.throws(() => parseVisitOptions(['--base-url=http://example.invalid']), /loopback/);
  assert.throws(() => parseVisitOptions(['--base-url=http://127.0.0.1/path']), /loopback/);
  assert.throws(() => parseVisitOptions(['--visitors=9']), /visitors/);
  assert.throws(() => parseVisitOptions(['--visits=65']), /visits/);
  assert.equal(parseVisitOptions(['--base-url=http://localhost:8787', '--mode=reads']).visitors, 4);
});

test('executes the real browse request graph and local-only writes with valid protocol responses', async () => {
  const seen = [];
  await withServer((request, response) => {
    seen.push({ path: request.url, cookie: request.headers.cookie, range: request.headers.range });
    if (request.url.startsWith('/rest/getCoverArt')) {
      response.writeHead(200, { 'content-type': 'image/png' }); response.end(Buffer.from([137, 80, 78, 71])); return;
    }
    if (request.url.startsWith('/rest/stream')) {
      response.writeHead(206, { 'content-type': 'audio/wav' }); response.end(Buffer.alloc(16)); return;
    }
    if (request.url.startsWith('/edgesonic/')) {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}'); return;
    }
    const body = request.url.startsWith('/rest/createPlaylist') ? '<subsonic-response status="ok"><playlist id="pressure-playlist-fixture"/></subsonic-response>' : xml;
    response.writeHead(200, { 'content-type': 'application/xml' }); response.end(body);
  }, async (baseUrl) => {
    const report = await runVisitPressure(parseVisitOptions(['--base-url=' + baseUrl, '--mode=compare', '--visits=1', '--visitors=1', '--concurrency=1']));
    assert.equal(report.reads.errors, 0);
    assert.equal(report.mixed.errors, 0);
    assert(report.mixed.readWriteOverlappingReads > 0);
    assert.equal(report.mixed.completedVisits, 1);
    assert(report.mixed.peakRequestsInFlight > 1);
    assert.equal(report.reads.endpoints.getAlbumList2.requests, report.mixed.endpoints.getAlbumList2.requests);
    assert.equal(report.reads.endpoints.search3.requests, report.mixed.endpoints.search3.requests);
    assert.equal(report.mixed.endpoints.star.requests, 1);
    assert.equal(report.mixed.endpoints.unstar.requests, 1);
    assert.equal(report.mixed.endpoints.createPlaylist.requests, 2);
    assert.equal(report.mixed.endpoints.updatePlaylist.requests, 1);
    assert.equal(report.mixed.endpoints.deletePlaylist.requests, 1);
    assert(seen.some((item) => item.path.startsWith('/rest/getCoverArt')));
    assert(seen.some((item) => item.range === 'bytes=0-65535'));
    assert(seen.every((item) => /^edgesonic_session=pressure-visitor-token-\d{2}$/.test(item.cookie)));
    assert(seen.some((item) => item.path.includes('pressure-playlist-fixture')));
  });
});

test('uses equivalent read graph in both modes and records overlapping intervals', async () => {
  const visitRunner = async () => {
    const start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { results: [{ endpoint: 'browse', group: 'read', status: 200, elapsedMs: 10, error: null }], intervals: [{ endpoint: 'browse', group: 'read', startedAt: start, endedAt: Date.now() }] };
  };
  const writeRunner = async (_options, _visitor, _index, results, intervals) => {
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 3));
    const endedAt = Date.now();
    results.push({ endpoint: 'star', group: 'write', status: 200, elapsedMs: 3, error: null });
    intervals.push({ endpoint: 'star', group: 'write', startedAt, endedAt });
  };
  const report = await runVisitPressure({ mode: 'compare', visits: 2, visitors: 1, concurrency: 1 }, { visitRunner, writeRunner });
  assert.equal(report.reads.endpoints.browse.requests, report.mixed.endpoints.browse.requests);
  assert.equal(report.reads.endpoints.star, undefined);
  assert(report.mixed.readWriteOverlappingReads > 0);
  assert.equal(report.matchedReadLatencyRatios.browse.readsP95Ratio, 1);
});
