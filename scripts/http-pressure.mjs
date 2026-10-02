#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const STAGES = [1, 5, 10, 20, 40];
const MAX_REQUESTS = 2500;
const MAX_TIMEOUT_MS = 30000;
const PATHS = {
  stats: () => '/edgesonic/stats/library',
  search20: () => '/rest/search3.view?query=pressure-probe&songCount=20',
  search100: () => '/rest/search3.view?query=pressure-probe&songCount=100',
  search500: () => '/rest/search3.view?query=pressure-probe&songCount=500',
};

export function parseOptions(env = process.env, argv = process.argv.slice(2)) {
  const args = Object.fromEntries(argv.map((arg) => {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error('Options must use --name=value syntax.');
    return [match[1], match[2]];
  }));
  const base = args['base-url'] ?? env.PRESSURE_BASE_URL;
  if (!base) throw new Error('Set --base-url or PRESSURE_BASE_URL.');
  const baseUrl = new URL(base);
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
    headers = JSON.parse(env.PRESSURE_HEADERS_JSON);
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

function routeFor(scenario, index) {
  if (scenario === 'stats') return ['stats', PATHS.stats()];
  if (scenario === 'search3') {
    const key = ['search20', 'search100', 'search500'][index % 3];
    return [key, PATHS[key]()];
  }
  const mixed = [['stats', PATHS.stats()], ['search20', PATHS.search20()], ['search100', PATHS.search100()], ['search500', PATHS.search500()]];
  return mixed[index % mixed.length];
}

async function oneRequest(baseUrl, headers, path, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(new URL(path, baseUrl), { method: 'GET', headers, signal: controller.signal, redirect: 'error' });
    const elapsed = Math.round(performance.now() - started);
    const serverTiming = response.headers.get('server-timing');
    const cfRay = response.headers.get('cf-ray');
    await response.body?.cancel();
    let errorClass = null;
    if (response.status === 429) errorClass = 'rate_limit';
    else if (response.status >= 500) errorClass = 'http_5xx';
    else if (!response.ok) errorClass = 'http_4xx';
    return { elapsed, status: response.status, errorClass, serverTiming: Boolean(serverTiming), colo: cfRay?.split('-').at(-1) ?? null };
  } catch (error) {
    return { elapsed: Math.round(performance.now() - started), status: null, errorClass: error?.name === 'AbortError' ? 'timeout' : 'transport', serverTiming: false, colo: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function runPressure(options, { onStage = () => {}, fetcher = oneRequest } = {}) {
  let stopped = false;
  const results = [];
  const stages = [];
  for (const concurrency of STAGES) {
    const stageStart = results.length;
    let next = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (!stopped && next < options.requests) {
        const index = next++;
        const [endpoint, path] = routeFor(options.scenario, index);
        const result = await fetcher(options.baseUrl, options.headers, path, options.timeoutMs);
        results.push({ endpoint, ...result });
        const stageResults = results.slice(stageStart);
        const errors = stageResults.filter((item) => ['rate_limit', 'http_5xx', 'transport', 'timeout'].includes(item.errorClass)).length;
        const p95 = percentile(stageResults.map((item) => item.elapsed), 0.95);
        if (errors >= options.errorThreshold || (p95 !== null && p95 >= options.p95AbortMs)) stopped = true;
      }
    });
    await Promise.all(workers);
    const stage = summarize(results.slice(stageStart), concurrency, options);
    stages.push(stage);
    onStage(stage);
    if (stopped) break;
  }
  return { stoppedEarly: stopped, stages, results };
}

export function summarize(items, concurrency, options) {
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
      successes: values.filter((item) => item.status >= 200 && item.status < 400).length,
      statuses,
      errors,
      rateLimited: errors.rate_limit ?? 0,
      latencyMs: { median: percentile(values.map((item) => item.elapsed), 0.5), p95: percentile(values.map((item) => item.elapsed), 0.95), p99: percentile(values.map((item) => item.elapsed), 0.99) },
      serverTimingResponses: values.filter((item) => item.serverTiming).length,
      cfColos: [...new Set(values.map((item) => item.colo).filter(Boolean))],
    };
  }
  return { concurrency, requestedPerStage: options.requests, total: items.length, endpoints };
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
