import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

const origin = 'http://localhost:8796';
const session = 'edgesonic_session=mcp-runtime-fixture-session';
async function checked(path, init, status = 200) {
  const response = await fetch(new URL(path, origin), { ...init, redirect: 'manual' });
  assert.equal(response.status, status, `${path}: ${await response.clone().text()}`);
  return response;
}

await checked('/mcp', { method: 'POST', body: '{}' }, 404);
await checked('/edgesonic/features/update', { method: 'POST', headers: { Cookie: session, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'mcp_enabled', value: 1 }) });
const registered = await checked('/oauth/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_name: 'MCP runtime fixture', redirect_uris: ['http://127.0.0.1:4321/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }),
}, 201);
const { client_id } = await registered.json();
const verifier = randomBytes(32).toString('base64url');
const params = new URLSearchParams({ client_id, redirect_uri: 'http://127.0.0.1:4321/callback', response_type: 'code', scope: 'mcp:read mcp:write mcp:upload', state: randomBytes(16).toString('hex'), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${origin}/mcp` });
const consent = await checked(`/authorize?${params}`, { headers: { Cookie: session } });
const page = await consent.text();
const handle = /name="handle" value="([^"]+)"/.exec(page)?.[1];
assert.ok(handle);
const cookies = consent.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
const form = new URLSearchParams({ handle, decision: 'approve' });
for (const scope of ['mcp:read', 'mcp:write', 'mcp:upload']) form.append('scope', scope);
const approved = await checked('/authorize', { method: 'POST', headers: { Cookie: `${session}; ${cookies}` }, body: form }, 302);
const code = new URL(approved.headers.get('Location')).searchParams.get('code');
const exchanged = await checked('/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id, code, redirect_uri: 'http://127.0.0.1:4321/callback', code_verifier: verifier, resource: `${origin}/mcp` }) });
const { access_token } = await exchanged.json();
const authorization = { Authorization: `Bearer ${access_token}` };
let serial = 0;
async function rpc(method, params, allowError = false) {
  const response = await checked('/mcp', { method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++serial, method, params }) });
  const text = await response.text();
  const value = text.startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').filter(line => line.startsWith('data: ')).at(-1).slice(6));
  if (allowError) return value;
  assert.ok(!value.error, JSON.stringify(value.error));
  return value.result;
}
async function call(name, args) {
  const result = await rpc('tools/call', { name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return result.structuredContent;
}

const tools = await rpc('tools/list', {});
assert.ok(tools.tools.some(tool => tool.name === 'create_upload'));
assert.ok(!tools.tools.some(tool => tool.name.startsWith('delete_')));
const name = `runtime-${randomBytes(6).toString('hex')}.wav`;
const wav = Buffer.alloc(44 + 16000);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(16000, 40);
const ticket = await call('create_upload', { name, path: 'music/runtime', size: wav.length });
await checked(new URL(ticket.uploadUrl).pathname, { method: 'PUT', headers: { ...authorization, 'Content-Length': String(wav.length), 'Content-Type': 'audio/wav' }, body: wav });
const uploaded = await call('finish_upload', { uploadId: ticket.uploadId });
assert.ok(uploaded.id, JSON.stringify(uploaded));
assert.equal(uploaded.metadataToken, undefined);
assert.equal(uploaded.metadataStatus, 'direct');
const applied = await call('submit_upload_metadata', { uploadId: ticket.uploadId, tags: { title: 'Runtime fixture', artist: 'Fixture artist', album: 'Fixture album', duration: 1, sampleRate: 8000, bitDepth: 16, channels: 1, bitrate: 128, container: 'WAVE', codec: 'PCM' } });
assert.equal(applied.ok, true);
const catalog = await call('get_metadata', { id: uploaded.id });
assert.ok(catalog.song, JSON.stringify(catalog));
assert.equal(catalog.song.title, 'Runtime fixture');
assert.equal(catalog.song.duration, 1);
const changed = await call('update_metadata', { id: uploaded.id, tags: { title: 'Updated runtime fixture' } });
assert.equal(changed.ok, true);
assert.ok(changed.files.some(file => file.written === false && /wav/.test(file.reason)));
const movedPath = `music/runtime/moved-${name}`;
await call('move_file', { path: `music/runtime/${name}`, dest: movedPath });
const listed = await call('list_files', { path: 'music/runtime' });
assert.ok(listed.entries.some(entry => entry.path === movedPath));
const preview = await call('organize_files', { ids: [uploaded.id], template: '{albumArtist}/{album}/{title}' });
assert.equal(preview.dryRun, true);
const blocked = await rpc('tools/call', { name: 'delete_file', arguments: { path: movedPath } }, true);
assert.ok(blocked.error || blocked.result?.isError);
const grantsResponse = await checked('/edgesonic/mcp/grants', { headers: { Cookie: session } });
const grants = await grantsResponse.json();
const grant = grants.items.find(item => item.clientId === client_id);
assert.ok(grant, JSON.stringify(grants.items.map(item => Object.keys(item))));
await checked('/edgesonic/mcp/grants/revoke', { method: 'POST', headers: { Cookie: session, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ grantId: grant.id }) });
await checked('/mcp', { method: 'POST', headers: authorization, body: '{}' }, 401);
await checked('/edgesonic/features/update', { method: 'POST', headers: { Cookie: session, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'mcp_enabled', value: 0 }) });
await checked('/.well-known/oauth-authorization-server', {}, 404);
console.log('Single-switch local workerd OAuth and upload metadata flow passed without extra keys or bindings; deletion denial and revocation passed.');
