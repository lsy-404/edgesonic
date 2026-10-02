import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { parseOptions, runPressure } from '../scripts/http-pressure.mjs';

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('runs bounded read-only endpoint scenarios and returns aggregate metrics only', async () => {
  const received = [];
  await withServer((request, response) => {
    received.push({ method: request.method, url: request.url, cookie: request.headers.cookie });
    response.writeHead(200, { 'content-type': 'application/json', 'server-timing': 'db;dur=2', 'cf-ray': 'local-YYZ' });
    response.flushHeaders();
    const payload = request.url.startsWith('/rest/')
      ? JSON.stringify({ 'subsonic-response': { status: 'ok', searchResult3: { song: [{ id: 'private-id', title: 'private-title' }, { id: 'private-id-2', title: 'private-title-2' }] } } })
      : JSON.stringify({ ok: true, private: 'response-secret' });
    setTimeout(() => response.end(payload), 40);
  }, async (baseUrl) => {
    const options = parseOptions({ PRESSURE_HEADERS_JSON: '{"authorization":"Bearer secret"}', PRESSURE_COOKIE: 'session=secret', PRESSURE_API_KEY: 'api-secret', PRESSURE_USERNAME: 'reader', PRESSURE_QUERY: 'real track' }, ['--base-url=' + baseUrl, '--scenario=mixed', '--requests=2']);
    const stages = [];
    const report = await runPressure(options, { onStage: (stage) => stages.push(stage) });
    assert.equal(report.stoppedEarly, false);
    assert.equal(report.results.length, 10);
    assert.equal(stages.length, 5);
    assert.deepEqual([...new Set(received.map((item) => item.method))], ['GET']);
    assert(received.every((item) => item.url === '/edgesonic/stats/library' || item.url.startsWith('/rest/search3.view?')));
    const searchParams = new URLSearchParams(received.find((item) => item.url.startsWith('/rest/')).url.split('?')[1]);
    assert.equal(searchParams.get('query'), 'real track');
    assert.equal(searchParams.get('artistCount'), '0');
    assert.equal(searchParams.get('albumCount'), '0');
    assert.equal(searchParams.get('songCount'), '20');
    assert.equal(searchParams.get('songSort'), 'oldest');
    assert.equal(searchParams.get('apiKey'), 'api-secret');
    assert.equal(searchParams.get('u'), 'reader');
    assert.equal(searchParams.get('f'), 'json');
    assert(received.every((item) => item.cookie === 'session=secret'));
    assert.equal(stages[0].endpoints.stats.serverTimingResponses, 1);
    assert.deepEqual(stages[0].endpoints.stats.cfColos, ['YYZ']);
    assert.equal(stages[0].endpoints.stats.successes, 1);
    assert(stages[0].endpoints.stats.responseBytes.total > 0);
    assert(stages[0].endpoints.stats.endToEndMs.median >= 30);
    assert(stages[0].endpoints.stats.ttfbMs.median < stages[0].endpoints.stats.endToEndMs.median);
    const searchStage = stages.find((stage) => stage.endpoints.search20_oldest);
    assert.equal(searchStage.endpoints.search20_oldest.returnedSongCount.total, 2);
    assert(searchStage.endpoints.search20_oldest.responseBytes.max > 0);
    assert.equal(JSON.stringify({ stages, report }).includes('response-secret'), false);
    assert.equal(JSON.stringify({ stages, report }).includes('Bearer secret'), false);
    assert.equal(JSON.stringify({ stages, report }).includes('api-secret'), false);
    assert.equal(JSON.stringify({ stages, report }).includes('real track'), false);
    assert.equal(JSON.stringify({ stages, report }).includes('private-title'), false);
    assert.equal(JSON.stringify({ stages, report }).includes('private-id'), false);
  });
});

test('stops ramp after the configured error threshold and counts 429 separately', async () => {
  await withServer((_request, response) => {
    response.writeHead(429);
    response.end('private response');
  }, async (baseUrl) => {
    const options = parseOptions({}, ['--base-url=' + baseUrl, '--scenario=stats', '--requests=10', '--error-threshold=2']);
    const report = await runPressure(options);
    assert.equal(report.stoppedEarly, true);
    assert.equal(report.results.length, 2);
    assert.equal(report.results[0].errorClass, 'rate_limit');
  });
});

test('rejects mutation-shaped paths and unbounded settings at configuration time', () => {
  assert.throws(() => parseOptions({}, ['--base-url=https://example.invalid', '--scenario=mutate']), /Scenario/);
  assert.throws(() => parseOptions({}, ['--base-url=https://example.invalid/path?token=secret']), /Base URL/);
  assert.throws(() => parseOptions({}, ['--base-url=https://example.invalid', '--requests=501']), /requests/);
  assert.throws(() => parseOptions({ PRESSURE_HEADERS_JSON: '{"authorization":"top-secret' }, ['--base-url=https://example.invalid']), (error) => !error.message.includes('top-secret'));
});

test('treats HTTP 200 protocol failures as errors and stops immediately on authentication failure', async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html>login page</html>');
  }, async (baseUrl) => {
    const report = await runPressure(parseOptions({}, ['--base-url=' + baseUrl, '--scenario=stats', '--requests=5']));
    assert.equal(report.results[0].errorClass, 'protocol_error');
    assert.equal(report.results.length, 3);
    assert.equal(report.stoppedEarly, true);
  });
  await withServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end('{"ok":false}');
  }, async (baseUrl) => {
    const report = await runPressure(parseOptions({}, ['--base-url=' + baseUrl, '--scenario=stats', '--requests=5']));
    assert.equal(report.results[0].errorClass, 'auth_error');
    assert.equal(report.results.length, 1);
    assert.equal(report.stoppedEarly, true);
  });
});

test('defaults to the full search and covers oldest/newest 20, 100, and 500 song pages', async () => {
  const urls = [];
  await withServer((request, response) => {
    urls.push(request.url);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ 'subsonic-response': { status: 'ok' } }));
  }, async (baseUrl) => {
    const options = parseOptions({}, ['--base-url=' + baseUrl, '--scenario=search3', '--requests=20']);
    const report = await runPressure(options);
    assert.equal(report.stoppedEarly, false);
    const pages = new Set(urls.map((url) => {
      const params = new URLSearchParams(url.split('?')[1]);
      assert.equal(params.get('query'), '');
      assert.equal(params.get('artistCount'), '0');
      assert.equal(params.get('albumCount'), '0');
      assert.equal(params.get('songOffset'), '0');
      return `${params.get('songCount')}:${params.get('songSort')}`;
    }));
    assert.deepEqual([...pages].sort(), ['100:newest', '100:oldest', '20:newest', '20:oldest', '500:newest', '500:oldest']);
  });
});

test('reports and runs effective concurrency when the stage target exceeds requests', async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  }, async (baseUrl) => {
    const options = parseOptions({}, ['--base-url=' + baseUrl, '--scenario=stats']);
    assert.equal(options.requests, 20);
    const report = await runPressure(options);
    assert.equal(report.stages.at(-1).configuredConcurrency, 40);
    assert.equal(report.stages.at(-1).concurrency, 20);
    assert.equal(report.stages.at(-1).total, 20);
    assert(report.stages.every((stage) => stage.concurrency <= stage.configuredConcurrency));
  });
});
