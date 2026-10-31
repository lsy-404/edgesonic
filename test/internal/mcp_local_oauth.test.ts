import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { auth } from '../../tools/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js';
import { LocalOAuthProvider } from '../../tools/mcp/oauth.js';

test('SDK OAuth flow validates callback and persists registration and refreshed tokens', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'edgesonic-oauth-'));
  let origin = '';
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, origin);
    if (url.pathname.includes('oauth-protected-resource')) { res.writeHead(404).end(); return; }
    if (url.pathname.includes('oauth-authorization-server')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] })); return; }
    if (url.pathname === '/register') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ client_id: 'client', redirect_uris: [provider.redirectUrl] })); return; }
    if (url.pathname === '/token') { let body = ''; for await (const chunk of req) body += chunk; const params = new URLSearchParams(body); requests.push(params.get('grant_type')!); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ access_token: requests.length === 1 ? 'first' : 'refreshed', token_type: 'Bearer', refresh_token: 'refresh', expires_in: 3600 })); return; }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const provider = await LocalOAuthProvider.create(origin, dir);
  const originalWrite = process.stderr.write;
  let authorization = '';
  try {
    await provider.prepare();
    process.stderr.write = ((chunk: any) => { authorization += String(chunk); return true; }) as typeof process.stderr.write;
    assert.equal(await auth(provider, { serverUrl: `${origin}/mcp` }), 'REDIRECT');
    process.stderr.write = originalWrite;
    const authUrl = new URL(authorization.trim().split('\n').at(-1)!);
    const callback = new URL(provider.redirectUrl);
    callback.searchParams.set('state', 'wrong'); callback.searchParams.set('code', 'bad');
    assert.equal((await fetch(callback)).status, 400);
    callback.searchParams.set('state', authUrl.searchParams.get('state')!); callback.searchParams.set('code', 'good');
    assert.equal((await fetch(callback)).status, 200);
    assert.equal(await auth(provider, { serverUrl: `${origin}/mcp`, authorizationCode: await provider.authorizationCode() }), 'AUTHORIZED');
    assert.equal(provider.tokens()?.access_token, 'first');
    assert.equal(await auth(provider, { serverUrl: `${origin}/mcp` }), 'AUTHORIZED');
    assert.equal(provider.tokens()?.access_token, 'refreshed');
    const reloaded = await LocalOAuthProvider.create(origin, dir);
    assert.equal(reloaded.tokens()?.access_token, 'refreshed');
    assert.equal(reloaded.clientInformation()?.client_id, 'client');
    const files = await import('node:fs/promises').then(fs => fs.readdir(dir));
    assert.ok((await readFile(path.join(dir, files[0]), 'utf8')).includes('refreshed'));
    if (process.platform !== 'win32') assert.equal((await stat(path.join(dir, files[0]))).mode & 0o777, 0o600);
    assert.deepEqual(requests, ['authorization_code', 'refresh_token']);
  } finally { process.stderr.write = originalWrite; await provider.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});
