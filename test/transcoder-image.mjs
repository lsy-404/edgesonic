import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const [image, mode] = process.argv.slice(2);
assert.ok(image && ['sandbox', 'external'].includes(mode), 'image and transcoder mode are required');
const name = `transcoder-check-${randomUUID()}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const key = randomUUID();
let started = false;

function audioFixture() {
  const rate = 44100;
  const samples = rate / 2;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 440 * Math.PI * 2 / rate) * 12000), 44 + i * 2);
  return wav;
}

try {
  docker('run', '-d', '--name', name, '-e', `SHARED_KEY=${key}`, image);
  started = true;
  const status = (authenticate) => docker('exec', name, 'node', '-e', `fetch('http://127.0.0.1:8080/health', {headers:${authenticate ? "{'X-EdgeSonic-Container-Key':process.env.SHARED_KEY}" : '{}'}}).then(r=>console.log(r.status)).catch(()=>console.log(0))`);
  let healthy = false;
  for (let i = 0; i < 40; i++) {
    healthy = status(true) === '200';
    if (healthy) break;
    await setTimeout(250);
  }
  assert.ok(healthy, 'container health endpoint must become available');
  if (mode === 'external') assert.equal(status(false), '401');
  const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1'];
  const query = mode === 'external' ? 'profile=mp3-128k' : `args=${encodeURIComponent(JSON.stringify(args))}`;
  const request = `fetch('http://127.0.0.1:8080/transcode?${query}', {method:'POST',headers:{'X-EdgeSonic-Container-Key':process.env.SHARED_KEY},body:require('node:fs').readFileSync(0),signal:AbortSignal.timeout(15000)}).then(async r=>{if(r.status!==200)throw new Error('HTTP '+r.status);process.stdout.write(Buffer.from(await r.arrayBuffer()))}).catch(e=>{console.error(e.message);process.exit(1)})`;
  const bytes = execFileSync('docker', ['exec', '-i', name, 'node', '-e', request], { input: audioFixture() });
  assert.ok(bytes.length > 200, 'transcoder must return encoded audio');
  const probe = execFileSync('docker', ['exec', '-i', name, 'ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name,sample_rate', '-of', 'json', 'pipe:0'], { input: bytes, encoding: 'utf8' });
  assert.equal(JSON.parse(probe).streams[0].codec_name, 'mp3');
  assert.ok(Number(JSON.parse(probe).streams[0].sample_rate) > 0);
  console.log(`${mode} container health, authorization and WAV-to-MP3 streaming passed`);
} finally {
  if (started) execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
}
