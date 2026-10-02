#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const STAGES = [1, 5, 10, 20, 40];
const MAX_REQUESTS = 2500;
const MAX_TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const PATHS = {
  stats: () => '/edgesonic/stats/library',
};

function searchPath({ searchQuery, apiKey, username }, songCount, songSort) {
  const params = new URLSearchParams({
    query: searchQuery,
    artistCount: '0',
    albumCount: '0',
    songCount: String(songCount),
    songOffset: '0',
    songSort,
    f: 'json',
  });
  if (apiKey) params.set('apiKey', apiKey);
  if (username) params.set('u', username);
  return `/rest/search3.view?${params}`;
}

export function parseOptions(env = process.env, argv = process.argv.slice(2)) {
  const args = Object.fromEntries(argv.map((arg) => {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error('Options must use --name=value syntax.');
    return [match[1], match[2]];
  }));
  const base = args['base-url'] ?? env.PRESSURE_BASE_URL;
  if (!base) throw new Error('Set --base-url or PRESSURE_BASE_URL.');
  let baseUrl;
  try { baseUrl = new URL(base); } catch { throw new Error('Invalid base URL.'); }
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('Base URL must be http(s) and contain no credentials, query, or fragment.');
  }
  const scenario = args.scenario ?? 'mixed';
  if (!['stats', 'search3', 'mixed'].includes(scenario)) throw new Error('Scenario must be stats, search3, or mixed.');
  const integer = (name, fallback, min, max) => {
    const value = Number(args[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}.`);
    return value;
  };
  const requests = integer('requests', env.PRESSURE_REQUESTS ?? 20, 1, MAX_REQUESTS / STAGES.length);
  let headers = {};
  if (env.PRESSURE_HEADERS_JSON) {
    try { headers = JSON.parse(env.PRESSURE_HEADERS_JSON); } catch { throw new Error('PRESSURE_HEADERS_JSON must be valid JSON.'); }
    if (!headers || Array.isArray(headers) || typeof headers !== 'object') throw new Error('PRESSURE_HEADERS_JSON must be an object.');
  }
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string' || /^(host|content-length|connection)$/i.test(name)) throw new Error('Invalid request header configuration.');
  }
  if (env.PRESSURE_COOKIE) headers.cookie = env.PRESSURE_COOKIE;
  return {
    baseUrl,
    scenario,
    requests,
    searchQuery: env.PRESSURE_QUERY ?? '',
    apiKey: env.PRESSURE_API_KEY ?? '',
    username: env.PRESSURE_USERNAME ?? '',
    timeoutMs: integer('timeout-ms', env.PRESSURE_TIMEOUT_MS ?? 10000, 100, MAX_TIMEOUT_MS),
    errorThreshold: integer('error-threshold', env.PRESSURE_ERROR_THRESHOLD ?? 3, 1, 100),
    p95AbortMs: integer('p95-abort-ms', env.PRESSURE_P95_ABORT_MS ?? 3000, 1, 120000),
    headers,
  };
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]);
}

function httpErrorClass(status) {
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth_error';
  if (status >= 500) return 'http_5xx';
  if (status >= 400) return 'http_4xx';
  return null;
}

function routeFor(scenario, index, config) {
  if (scenario === 'stats') return ['stats', PATHS.stats()];
  const pages = [20, 100, 500].flatMap((count) => ['oldest', 'newest'].map((sort) => ({ count, sort })));
  if (scenario === 'search3') {
    const page = pages[index % pages.length];
    const key = `search${page.count}_${page.sort}`;
    return [key, searchPath(config, page.count, page.sort)];
  }
  const routeIndex = index % 7;
  if (routeIndex === 0) return ['stats', PATHS.stats()];
  const page = pages[routeIndex - 1];
  return [`search${page.count}_${page.sort}`, searchPath(config, page.count, page.sort)];
}

async function readBoundedBody(response) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

async function oneRequest(baseUrl, headers, path, timeoutMs, endpoint) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  let receivedStatus = null;
  let ttfbMs = null;
  let serverTiming = false;
  let colo = null;
  try {
    const response = await fetch(new URL(path, baseUrl), { method: 'GET', headers, signal: controller.signal, redirect: 'error' });
    receivedStatus = response.status;
    ttfbMs = Math.round(performance.now() - started);
    serverTiming = Boolean(response.headers.get('server-timing'));
    const cfRay = response.headers.get('cf-ray');
    colo = cfRay?.split('-').at(-1) ?? null;
    const body = await readBoundedBody(response);
    const elapsedMs = Math.round(performance.now() - started);
    let returnedSongCount = null;
    let errorClass = httpErrorClass(response.status);
    if (!errorClass) {
      if (!response.ok) errorClass = 'http_4xx';
      else if (body === null) errorClass = 'response_too_large';
      else if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) errorClass = 'protocol_error';
      else {
        try {
          const payload = JSON.parse(new TextDecoder().decode(body));
          if (endpoint === 'stats' ? payload?.ok !== true : payload?.['subsonic-response']?.status !== 'ok') errorClass = 'protocol_error';
          else if (endpoint !== 'stats') {
            const songs = payload['subsonic-response']?.searchResult3?.song;
            returnedSongCount = Array.isArray(songs) ? songs.length : songs == null ? 0 : 1;
          }
        } catch {
          errorClass = 'protocol_error';
        }
      }
    }
    return { elapsedMs, ttfbMs, status: receivedStatus, errorClass, responseBytes: body?.byteLength ?? null, returnedSongCount, serverTiming, colo };
  } catch (error) {
    return { elapsedMs: Math.round(performance.now() - started), ttfbMs, status: receivedStatus, errorClass: httpErrorClass(receivedStatus) ?? (error?.name === 'AbortError' ? 'timeout' : 'transport'), responseBytes: null, returnedSongCount: null, serverTiming, colo };
  } finally {
    clearTimeout(timer);
  }
}

export async function runPressure(options, { onStage = () => {}, fetcher = oneRequest } = {}) {
  let stopped = false;
  const results = [];
  const stages = [];
  for (const concurrency of STAGES) {
    const activeConcurrency = Math.min(concurrency, options.requests);
    const stageStart = results.length;
    let next = 0;
    const workers = Array.from({ length: activeConcurrency }, async () => {
      while (!stopped && next < options.requests) {
        const index = next++;
        const [endpoint, path] = routeFor(options.scenario, stageStart + index, options);
        const result = await fetcher(options.baseUrl, options.headers, path, options.timeoutMs, endpoint);
        results.push({ endpoint, ...result });
        const stageResults = results.slice(stageStart);
        const errors = stageResults.filter((item) => ['rate_limit', 'http_5xx', 'http_4xx', 'auth_error', 'transport', 'timeout', 'protocol_error', 'response_too_large'].includes(item.errorClass)).length;
        const p95 = percentile(stageResults.map((item) => item.elapsedMs), 0.95);
        if (result.errorClass === 'auth_error' || errors >= options.errorThreshold || (p95 !== null && p95 >= options.p95AbortMs)) stopped = true;
      }
    });
    await Promise.all(workers);
    const stage = summarize(results.slice(stageStart), activeConcurrency, options, concurrency);
    stages.push(stage);
    onStage(stage);
    if (stopped) break;
  }
  return { stoppedEarly: stopped, stages, results };
}

export function summarize(items, concurrency, options, configuredConcurrency = concurrency) {
  const groups = Object.groupBy(items, (item) => item.endpoint);
  const endpoints = {};
  for (const [name, values] of Object.entries(groups)) {
    const statuses = {};
    const errors = {};
    for (const item of values) {
      if (item.status !== null) statuses[item.status] = (statuses[item.status] ?? 0) + 1;
      if (item.errorClass) errors[item.errorClass] = (errors[item.errorClass] ?? 0) + 1;
    }
    endpoints[name] = {
      requests: values.length,
      successes: values.filter((item) => item.status >= 200 && item.status < 400 && item.errorClass === null).length,
      statuses,
      errors,
      rateLimited: errors.rate_limit ?? 0,
      responseBytes: aggregate(values.map((item) => item.responseBytes)),
      ...(name.startsWith('search') ? { returnedSongCount: aggregate(values.map((item) => item.returnedSongCount)) } : {}),
      endToEndMs: { median: percentile(values.map((item) => item.elapsedMs), 0.5), p95: percentile(values.map((item) => item.elapsedMs), 0.95), p99: percentile(values.map((item) => item.elapsedMs), 0.99) },
      ttfbMs: { median: percentile(values.map((item) => item.ttfbMs).filter(Number.isFinite), 0.5), p95: percentile(values.map((item) => item.ttfbMs).filter(Number.isFinite), 0.95), p99: percentile(values.map((item) => item.ttfbMs).filter(Number.isFinite), 0.99) },
      serverTimingResponses: values.filter((item) => item.serverTiming).length,
      cfColos: [...new Set(values.map((item) => item.colo).filter(Boolean))],
    };
  }
  return { concurrency, configuredConcurrency, requestedPerStage: options.requests, total: items.length, endpoints };
}

function aggregate(values) {
  const present = values.filter(Number.isFinite);
  return {
    total: present.reduce((sum, value) => sum + value, 0),
    min: present.length ? Math.min(...present) : null,
    max: present.length ? Math.max(...present) : null,
  };
}

async function main() {
  try {
    const options = parseOptions();
    const report = await runPressure(options, { onStage: (stage) => process.stdout.write(`${JSON.stringify(stage)}\n`) });
    process.stdout.write(`${JSON.stringify({ stoppedEarly: report.stoppedEarly, completedRequests: report.results.length })}\n`);
    if (report.stoppedEarly) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
