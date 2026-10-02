import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_VISITORS = 8;
const MAX_VISITS = 64;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_MS = 15000;
const SYNTHETIC_ID = /^pressure-(?:song|album|artist)-\d{3,5}$/;

export function parseVisitOptions(argv = process.argv.slice(2)) {
  const args = Object.fromEntries(argv.map((arg) => {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error('Options must use --name=value syntax.');
    return [match[1], match[2]];
  }));
  let baseUrl;
  try { baseUrl = new URL(args['base-url'] ?? 'http://127.0.0.1:8787'); } catch { throw new Error('Invalid local base URL.'); }
  const localHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (baseUrl.protocol !== 'http:' || !localHosts.has(baseUrl.hostname) || baseUrl.username || baseUrl.password || baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash) {
    throw new Error('Base URL must be a plain HTTP loopback origin.');
  }
  const integer = (name, fallback, min, max) => {
    const value = Number(args[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}.`);
    return value;
  };
  const mode = args.mode ?? 'compare';
  if (!['reads', 'mixed', 'compare'].includes(mode)) throw new Error('Mode must be reads, mixed, or compare.');
  const options = {
    baseUrl,
    mode,
    visits: integer('visits', 8, 1, MAX_VISITS),
    concurrency: integer('concurrency', 4, 1, MAX_VISITORS),
    timeoutMs: integer('timeout-ms', 5000, 100, MAX_TIMEOUT_MS),
    visitors: integer('visitors', Math.min(4, MAX_VISITORS), 1, MAX_VISITORS),
    warmups: integer('warmups', 1, 0, 2),
    rounds: integer('rounds', 3, 1, 5),
  };
  const runCount = mode === 'compare' ? options.warmups + options.rounds : 1;
  if (options.visits * runCount * 140 > 10000) throw new Error('Total request budget exceeds 10000.');
  return options;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]);
}

async function boundedMap(values, concurrency, mapper) {
  const output = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(values.length, concurrency) }, async () => {
    while (next < values.length) {
      const index = next++;
      output[index] = await mapper(values[index], index);
    }
  }));
  return output;
}

function xmlStatus(body) {
  return /<subsonic-response\b[^>]*\bstatus="ok"/.test(body)
    && /<\/subsonic-response\s*>\s*$/.test(body)
    && !/<error\b/.test(body);
}

function validateXml(endpoint, body) {
  if (!xmlStatus(body)) return false;
  const required = {
    getArtists: '<artist', search3: 'searchResult3',
    getArtist: '<artist', getArtistInfo: '<artistInfo', getAlbum: '<album',
    getSong: '<song', getLyricsBySongId: '<lyrics', getPlaylists: '<playlists',
    getPlaylist: '<playlist', star: '<subsonic-response', unstar: '<subsonic-response',
    createPlaylist: '<playlist', updatePlaylist: '<subsonic-response', deletePlaylist: '<subsonic-response',
  };
  return !required[endpoint] || body.includes(required[endpoint]);
}

async function boundedBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function requestSpec(endpoint, params = {}) {
  const query = new URLSearchParams({ c: 'edgesonic-pressure-visit', v: '1.16.1', f: 'xml' });
  for (const [key, value] of Object.entries(params)) {
    query.delete(key);
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }
  return { endpoint, path: `/rest/${endpoint}.view?${query}` };
}

function jsonSpec(endpoint, path, params = {}) {
  const query = new URLSearchParams(params);
  return { endpoint, path: `${path}${query.size ? `?${query}` : ''}`, json: true };
}

async function send(baseUrl, token, spec, timeoutMs, intervals) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  const startedAt = Date.now();
  let status = null;
  let elapsedMs = 0;
  let error = null;
  let bytes = null;
  try {
    const headers = { cookie: `edgesonic_session=${token}` };
    if (spec.range) headers.range = spec.range;
    const response = await fetch(new URL(spec.path, baseUrl), { method: 'GET', headers, signal: controller.signal, redirect: 'error' });
    status = response.status;
    const body = await boundedBody(response);
    elapsedMs = Math.round(performance.now() - start);
    bytes = body?.byteLength ?? null;
    if (!response.ok) error = `http_${response.status}`;
    else if (spec.requiredStatus && response.status !== spec.requiredStatus) error = 'unexpected_status';
    else if (spec.requiredStatus && response.status !== spec.requiredStatus) error = 'unexpected_status';
    else if (body === null) error = 'body_too_large';
    else if (spec.image && !response.headers.get('content-type')?.toLowerCase().startsWith('image/')) error = 'invalid_image';
    else if (spec.audio && !response.headers.get('content-type')?.toLowerCase().startsWith('audio/')) error = 'invalid_audio';
    else if (!spec.image && !spec.audio) {
      const text = new TextDecoder().decode(body);
      if (spec.json) {
        try { if (JSON.parse(text)?.ok !== true) error = 'invalid_json'; } catch { error = 'invalid_json'; }
      } else if (!validateXml(spec.endpoint, text)) error = 'invalid_xml';
    }
  } catch (cause) {
    elapsedMs = Math.round(performance.now() - start);
    error = cause?.name === 'AbortError' ? 'timeout' : 'transport';
  } finally { clearTimeout(timer); }
  const endedAt = Date.now();
  intervals.push({ endpoint: spec.endpoint, group: spec.group ?? (spec.write ? 'write' : 'read'), startedAt, endedAt });
  return { endpoint: spec.endpoint, group: spec.group ?? (spec.write ? 'write' : 'read'), status, elapsedMs, bytes, error, startedAt, endedAt };
}

function extractId(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*\\bid="([^"]+)"`));
  return match?.[1] ?? null;
}

async function call(baseUrl, token, endpoint, params, timeoutMs, results, intervals, options = {}) {
  const spec = requestSpec(endpoint, params);
  Object.assign(spec, options);
  const result = await send(baseUrl, token, spec, timeoutMs, intervals);
  results.push(result);
  return result;
}

async function payload(baseUrl, token, endpoint, params, timeoutMs, intervals) {
  const spec = requestSpec(endpoint, params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  const startedAt = Date.now();
  let result;
  let text = '';
  try {
    const response = await fetch(new URL(spec.path, baseUrl), { headers: { cookie: `edgesonic_session=${token}` }, signal: controller.signal, redirect: 'error' });
    const body = await boundedBody(response);
    text = body ? new TextDecoder().decode(body) : '';
    result = { endpoint, group: 'write', status: response.status, elapsedMs: Math.round(performance.now() - start), bytes: body?.byteLength ?? null,
      error: !response.ok ? `http_${response.status}` : body === null || !validateXml(endpoint, text) ? 'invalid_xml' : null, startedAt, endedAt: Date.now() };
  } catch (cause) {
    result = { endpoint, group: 'write', status: null, elapsedMs: Math.round(performance.now() - start), bytes: null, error: cause?.name === 'AbortError' ? 'timeout' : 'transport', startedAt, endedAt: Date.now() };
  } finally { clearTimeout(timer); }
  intervals.push({ endpoint, group: 'write', startedAt: result.startedAt, endedAt: result.endedAt });
  return { ...result, text };
}

async function readVisit(options, visitor, visitIndex) {
  const results = [];
  const intervals = [];
  const token = `pressure-visitor-token-${String(visitor).padStart(2, '0')}`;
  const song = `pressure-song-${String((visitIndex * 97) % 6000).padStart(5, '0')}`;
  const album = `pressure-album-${String((visitIndex * 37) % 500).padStart(3, '0')}`;
  const artist = `pressure-artist-${String((visitIndex * 19) % 200).padStart(3, '0')}`;

  const startup = [
    send(options.baseUrl, token, jsonSpec('version', '/edgesonic/version'), options.timeoutMs, intervals),
    send(options.baseUrl, token, jsonSpec('auth_me', '/edgesonic/auth/me'), options.timeoutMs, intervals),
    send(options.baseUrl, token, jsonSpec('messages', '/edgesonic/messages'), options.timeoutMs, intervals),
  ];
  results.push(...await Promise.all(startup));
  const fetchedCovers = new Set();
  const fetchCovers = async (ids) => {
    const unique = ids.filter((id) => { if (fetchedCovers.has(id)) return false; fetchedCovers.add(id); return true; });
    const covers = await boundedMap(unique, 6, (id) => send(options.baseUrl, token, { endpoint: 'getCoverArt', path: `/rest/getCoverArt.view?id=${id}`, image: true }, options.timeoutMs, intervals));
    results.push(...covers);
  };
  await Promise.all(['newest', 'frequent', 'recent'].map((type) => call(options.baseUrl, token, 'getAlbumList2', { type, size: '12', offset: '0' }, options.timeoutMs, results, intervals)));
  await fetchCovers(Array.from({ length: 12 }, (_, index) => `pressure-album-${String((visitIndex * 12 + index) % 500).padStart(3, '0')}`));
  await call(options.baseUrl, token, 'getArtists', {}, options.timeoutMs, results, intervals);
  await Promise.all([
    call(options.baseUrl, token, 'getAlbumList2', { type: 'alphabeticalByName', size: '24', offset: '0' }, options.timeoutMs, results, intervals),
    send(options.baseUrl, token, jsonSpec('album_display_groups', '/edgesonic/album-display-groups'), options.timeoutMs, intervals).then((r) => { results.push(r); return r; }),
  ].map((p) => p.then((r) => { if (!results.includes(r)) results.push(r); })));
  await call(options.baseUrl, token, 'getAlbumList2', { type: 'alphabeticalByName', size: '24', offset: '24' }, options.timeoutMs, results, intervals);
  await fetchCovers(Array.from({ length: 24 }, (_, index) => `pressure-album-${String((visitIndex * 24 + index) % 500).padStart(3, '0')}`));
  await call(options.baseUrl, token, 'search3', { query: '', artistCount: '0', albumCount: '0', songCount: '24', songOffset: String((visitIndex % 3) * 24) }, options.timeoutMs, results, intervals);
  await call(options.baseUrl, token, 'search3', { query: 'LoadTest', artistCount: '24', albumCount: '0', songCount: '0' }, options.timeoutMs, results, intervals);
  await Promise.all([
    call(options.baseUrl, token, 'search3', { query: 'LoadTest', artistCount: '0', albumCount: '24', songCount: '0' }, options.timeoutMs, results, intervals),
    call(options.baseUrl, token, 'search3', { query: 'LoadTest', artistCount: '0', albumCount: '0', songCount: '24', songOffset: String((visitIndex % 3) * 24) }, options.timeoutMs, results, intervals),
  ]);
  await Promise.all([
    call(options.baseUrl, token, 'getArtist', { id: artist }, options.timeoutMs, results, intervals),
    call(options.baseUrl, token, 'getArtistInfo', { id: artist, count: '1' }, options.timeoutMs, results, intervals),
  ]);
  await call(options.baseUrl, token, 'getAlbum', { id: album }, options.timeoutMs, results, intervals);
  await fetchCovers([album]);
  const media = await Promise.all([
    call(options.baseUrl, token, 'getSong', { id: song }, options.timeoutMs, results, intervals),
    call(options.baseUrl, token, 'getLyricsBySongId', { id: song, enhanced: 'true' }, options.timeoutMs, results, intervals),
    send(options.baseUrl, token, { endpoint: 'stream', path: `/rest/stream.view?id=${song}`, audio: true, range: 'bytes=0-65535', requiredStatus: 206 }, options.timeoutMs, intervals),
  ]);
  results.push(...media.filter((item) => item?.endpoint === 'stream'));
  await call(options.baseUrl, token, 'getPlaylists', {}, options.timeoutMs, results, intervals);
  await call(options.baseUrl, token, 'getPlaylist', { id: `pressure-visitor-playlist-${String(visitor).padStart(2, '0')}` }, options.timeoutMs, results, intervals);
  await call(options.baseUrl, token, 'getStarred2', {}, options.timeoutMs, results, intervals);
  return { results, intervals };
}

async function mixedWrites(options, visitor, visitIndex, results, intervals) {
  const token = `pressure-visitor-token-${String(visitor).padStart(2, '0')}`;
  const song = `pressure-song-${String((visitIndex * 97) % 6000).padStart(5, '0')}`;
  if (!SYNTHETIC_ID.test(song)) throw new Error('Refusing a non-fixture song ID.');
  await call(options.baseUrl, token, 'star', { id: song }, options.timeoutMs, results, intervals, { write: true });
  await call(options.baseUrl, token, 'unstar', { id: song }, options.timeoutMs, results, intervals, { write: true });
  const created = await payload(options.baseUrl, token, 'createPlaylist', { name: `pressure-visit-${visitor}-${visitIndex}`, songId: song }, options.timeoutMs, intervals);
  results.push(created);
  const playlistId = extractId(created.text, 'playlist');
  if (created.error || !playlistId) return;
  let deleted = false;
  try {
    await call(options.baseUrl, token, 'updatePlaylist', { playlistId, name: `pressure-visit-${visitor}-${visitIndex}-updated`, songIdToAdd: `pressure-song-${String((visitIndex * 97 + 1) % 6000).padStart(5, '0')}`, songIndexToRemove: '0' }, options.timeoutMs, results, intervals, { write: true });
    await call(options.baseUrl, token, 'createPlaylist', { playlistId, name: `pressure-visit-${visitor}-${visitIndex}-reordered`, songId: [song, `pressure-song-${String((visitIndex * 97 + 1) % 6000).padStart(5, '0')}`] }, options.timeoutMs, results, intervals, { write: true });
    const remove = await call(options.baseUrl, token, 'deletePlaylist', { id: playlistId }, options.timeoutMs, results, intervals, { write: true });
    deleted = !remove.error;
  } finally {
    if (!deleted) {
      const cleanup = await call(options.baseUrl, token, 'deletePlaylist', { id: playlistId }, options.timeoutMs, results, intervals, { write: true });
      if (cleanup.error) results.push({ endpoint: 'write_cleanup', group: 'write', status: cleanup.status, elapsedMs: cleanup.elapsedMs, bytes: cleanup.bytes, error: 'cleanup_failed', startedAt: cleanup.startedAt, endedAt: cleanup.endedAt });
    }
  }
}

function summarize(items) {
  const endpoints = {};
  for (const item of items) {
    const group = endpoints[item.endpoint] ??= { requests: 0, errors: 0, statuses: {}, errorTypes: {}, p50: null, p95: null, p99: null, _times: [] };
    group.requests++;
    if (item.status !== null) group.statuses[item.status] = (group.statuses[item.status] ?? 0) + 1;
    if (item.error) group.errors++;
    if (item.error) group.errorTypes[item.error] = (group.errorTypes[item.error] ?? 0) + 1;
    group._times.push(item.elapsedMs);
  }
  for (const item of Object.values(endpoints)) {
    item.p50 = percentile(item._times, 0.5); item.p95 = percentile(item._times, 0.95); item.p99 = percentile(item._times, 0.99); delete item._times;
  }
  const reads = items.filter((item) => item.group === 'read').map((item) => item.elapsedMs);
  const writes = items.filter((item) => item.group === 'write').map((item) => item.elapsedMs);
  return { requests: items.length, errors: items.filter((item) => item.error).length, readLatencyMs: { p50: percentile(reads, 0.5), p95: percentile(reads, 0.95), p99: percentile(reads, 0.99) }, writeLatencyMs: { p50: percentile(writes, 0.5), p95: percentile(writes, 0.95), p99: percentile(writes, 0.99) }, endpoints };
}

export async function runVisitPressure(options, { visitRunner = readVisit, writeRunner = mixedWrites } = {}) {
  if (options.visits > MAX_VISITS || options.concurrency > MAX_VISITORS || options.visitors > MAX_VISITORS || options.visits > options.visitors * 8) throw new Error('Visit limits exceeded.');
  const runMode = async (mode) => {
    const items = []; const intervals = []; let nextVisitor = 0;
    let completedVisits = 0;
    let activeVisits = 0;
    let peakActiveVisits = 0;
    const workers = Array.from({ length: Math.min(options.concurrency, options.visitors) }, async (_, workerIndex) => {
      let visitor;
      while (true) {
        visitor = nextVisitor++;
        if (visitor >= options.visitors) break;
        for (let visitIndex = visitor; visitIndex < options.visits; visitIndex += options.visitors) {
        activeVisits++;
        peakActiveVisits = Math.max(peakActiveVisits, activeVisits);
        try {
        if (mode === 'mixed') {
          const visitPromise = visitRunner(options, visitor, visitIndex);
          const writesPromise = writeRunner(options, visitor, visitIndex, items, intervals);
          const visit = await visitPromise;
          items.push(...visit.results);
          intervals.push(...visit.intervals);
          await writesPromise;
        } else {
          const visit = await visitRunner(options, visitor, visitIndex);
          items.push(...visit.results);
          intervals.push(...visit.intervals);
        }
        completedVisits++;
        } finally { activeVisits--; }
        }
      }
    });
    await Promise.all(workers);
    const writes = intervals.filter((item) => item.group === 'write');
    const overlappingReadsByEndpoint = {};
    for (const read of intervals.filter((item) => item.group === 'read')) {
      if (writes.some((write) => read.startedAt < write.endedAt && write.startedAt < read.endedAt)) {
        overlappingReadsByEndpoint[read.endpoint] = (overlappingReadsByEndpoint[read.endpoint] ?? 0) + 1;
      }
    }
    const readWriteOverlaps = Object.values(overlappingReadsByEndpoint).reduce((total, count) => total + count, 0);
    const requestEvents = intervals.flatMap((item) => [{ time: item.startedAt, delta: 1 }, { time: item.endedAt, delta: -1 }]).sort((a, b) => a.time - b.time || a.delta - b.delta);
    let activeRequests = 0;
    let peakRequestsInFlight = 0;
    for (const event of requestEvents) { activeRequests += event.delta; peakRequestsInFlight = Math.max(peakRequestsInFlight, activeRequests); }
    return {
      ...summarize(items),
      visits: options.visits,
      completedVisits,
      peakActiveVisits,
      peakRequestsInFlight,
      readWriteOverlappingReads: readWriteOverlaps,
      overlappingReadsByEndpoint,
      intervals: intervals.length,
      ...(mode === 'mixed' ? { writeWorkload: { starItemsPerVisit: 1, playlistSongsAtReorder: 2, playlistMutationRequests: { create: 2, update: 1, delete: 1 }, deletesTemporaryPlaylist: true } } : {}),
    };
  };
  if (options.mode === 'reads') return { reads: await runMode('reads') };
  if (options.mode === 'mixed') return { mixed: await runMode('mixed') };
  const compare = async () => {
    const reads = await runMode('reads');
    const mixed = await runMode('mixed');
    const ratios = {};
    for (const key of Object.keys(reads.endpoints)) {
      const a = reads.endpoints[key]; const b = mixed.endpoints[key];
      if (b) ratios[key] = { readsP95Ratio: a.p95 && b.p95 ? Number((b.p95 / a.p95).toFixed(3)) : null, readsP99Ratio: a.p99 && b.p99 ? Number((b.p99 / a.p99).toFixed(3)) : null };
    }
    return { reads, mixed, matchedReadLatencyRatios: ratios };
  };
  const warmupSamples = [];
  for (let index = 0; index < (options.warmups ?? 0); index++) warmupSamples.push(await compare());
  const samples = [];
  for (let index = 0; index < (options.rounds ?? 1); index++) samples.push(await compare());
  return { warmups: options.warmups, warmupSamples, samples, ...samples[0] };
}

async function main() {
  const options = parseVisitOptions();
  const report = await runVisitPressure(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const runs = [...(report.warmupSamples ?? []), ...(report.samples ?? [report])];
  if (runs.some((run) => [run.reads, run.mixed].some((group) => group?.errors))) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
