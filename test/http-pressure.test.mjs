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
    response.end(JSON.stringify({ private: 'response-secret' }));
  }, async (baseUrl) => {
    const options = parseOptions({ PRESSURE_HEADERS_JSON: '{"authorization":"Bearer secret"}', PRESSURE_COOKIE: 'session=secret' }, ['--base-url=' + baseUrl, '--scenario=mixed', '--requests=2']);
    const stages = [];
    const report = await runPressure(options, { onStage: (stage) => stages.push(stage) });
    assert.equal(report.stoppedEarly, false);
    assert.equal(report.results.length, 10);
    assert.equal(stages.length, 5);
    assert.deepEqual([...new Set(received.map((item) => item.method))], ['GET']);
    assert(received.every((item) => ['/edgesonic/stats/library', '/rest/search3.view?query=pressure-probe&songCount=20', '/rest/search3.view?query=pressure-probe&songCount=100', '/rest/search3.view?query=pressure-probe&songCount=500'].includes(item.url)));
    assert(received.every((item) => item.cookie === 'session=secret'));
    assert.equal(stages[0].endpoints.stats.serverTimingResponses, 1);
    assert.deepEqual(stages[0].endpoints.stats.cfColos, ['YYZ']);
    assert.equal(stages[0].endpoints.stats.successes, 1);
    assert.equal(JSON.stringify({ stages, report }).includes('response-secret'), false);
    assert.equal(JSON.stringify({ stages, report }).includes('Bearer secret'), false);
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
});
