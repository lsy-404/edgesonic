import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openLocalFile, uploadUrl } from '../../tools/mcp/src.js';

test('local files require a root and cannot escape it through traversal or symlinks', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'edgesonic-mcp-'));
  try {
    const root = path.join(temp, 'root');
    await mkdir(root);
    await writeFile(path.join(root, 'song.mp3'), 'test');
    await writeFile(path.join(temp, 'outside.mp3'), 'test');
    await assert.rejects(openLocalFile(undefined, 'song.mp3'), /EDGESONIC_LOCAL_ROOT/);
    const opened = await openLocalFile(root, 'song.mp3');
    await opened.file.close();
    await assert.rejects(openLocalFile(root, '../outside.mp3'), /outside/);
    await assert.rejects(openLocalFile(root, root), /outside|regular/);
    try {
      await symlink(path.join(temp, 'outside.mp3'), path.join(root, 'link.mp3'), 'file');
      await assert.rejects(openLocalFile(root, 'link.mp3'), /outside/);
    } catch (error: any) { if (error.code !== 'EPERM') throw error; }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('upload tickets cannot redirect credentials or target arbitrary endpoints', () => {
  const base = new URL('https://music.example/mcp');
  assert.equal(uploadUrl(base, '/mcp/upload/abc', 'abc').href, 'https://music.example/mcp/upload/abc');
  for (const url of ['https://evil.example/mcp/upload/abc', '/mcp/upload/other', '/mcp/upload/abc?x=1', '/other']) {
    assert.throws(() => uploadUrl(base, url, 'abc'), /Invalid upload URL/);
  }
});

test('stdio server lists local tools and reports missing file scope', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.resolve('tools/mcp/package.json'));
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [require.resolve('tsx/cli'), path.resolve('tools/mcp/main.ts')], env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '' } });
  const client = new Client({ name: 'test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.ok(listed.tools.some((item: any) => item.name === 'search_metadata_local'));
    const result = await client.callTool({ name: 'read_local_metadata', arguments: { localPath: 'song.mp3' } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /EDGESONIC_LOCAL_ROOT/);
  } finally { await client.close(); }
});


test('stdio server reads tags from a real audio fixture', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.resolve('tools/mcp/package.json'));
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [require.resolve('tsx/cli'), path.resolve('tools/mcp/main.ts')], env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', EDGESONIC_LOCAL_ROOT: path.resolve('test/fixtures') } });
  const client = new Client({ name: 'test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'read_local_metadata', arguments: { localPath: 'wav-flac-metadata-source.wav' } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const payload = JSON.parse(result.content[0].text);
    assert.ok(payload.format);
    assert.ok(Object.keys(payload.tags).length > 0);
  } finally { await client.close(); }
});

test('bridge proxies remote tools and distinguishes uploaded files from metadata failure', async () => {
  const { createRequire } = await import('node:module');
  const { createServer } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const require = createRequire(path.resolve('tools/mcp/package.json'));
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  const remote = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => "test-session", enableJsonResponse: true });
  remote.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ['create_upload', 'finish_upload', 'submit_upload_metadata', 'remote_echo'].map(name => ({ name, inputSchema: { type: 'object' } })) }));
  let submittedTags: Record<string, unknown> | undefined;
  let creates = 0;
  remote.setRequestHandler(CallToolRequestSchema, async ({ params }: any) => {
    if (params.name === 'create_upload') creates++;
    if (params.name === 'submit_upload_metadata') submittedTags = params.arguments.tags;
    if (params.name === 'submit_upload_metadata') return { isError: true, content: [{ type: 'text', text: 'scope denied' }] };
    const data = params.name === 'create_upload' ? { uploadId: 'ticket', uploadUrl: '/mcp/upload/ticket', method: 'PUT' } : params.name === 'finish_upload' ? { ok: true, id: 'song', status: 'ok' } : { echoed: params.arguments };
    return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
  });
  await remote.connect(transport);
  let uploaded = 0;
  const http = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer secret');
    if (req.url === '/mcp/upload/ticket') {
      for await (const chunk of req) uploaded += chunk.length;
      res.writeHead(200).end('{}');
    } else await transport.handleRequest(req, res);
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as any).port;
  const appdata = await mkdtemp(path.join(os.tmpdir(), 'edgesonic-auth-'));
  const origin = `http://127.0.0.1:${port}`;
  const credentialDir = path.join(appdata, 'EdgeSonic', 'mcp');
  await mkdir(credentialDir, { recursive: true });
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const callbackPort = (probe.address() as any).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  await writeFile(path.join(credentialDir, `${createHash('sha256').update(origin).digest('hex')}.json`), JSON.stringify({ redirectUrl: `http://127.0.0.1:${callbackPort}/callback`, tokens: { access_token: 'secret', token_type: 'Bearer' } }));
  const localTransport = new StdioClientTransport({ command: process.execPath, args: [require.resolve('tsx/cli'), path.resolve('tools/mcp/main.ts')], env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', LOCALAPPDATA: appdata, EDGESONIC_LOCAL_ROOT: path.resolve('test/fixtures'), EDGESONIC_URL: origin } });
  const client = new Client({ name: 'test', version: '1.0.0' });
  try {
    await client.connect(localTransport);
    assert.ok((await client.listTools()).tools.some((tool: any) => tool.name === 'remote_echo'));
    const echo = await client.callTool({ name: 'remote_echo', arguments: { value: 5 } });
    assert.deepEqual(echo.structuredContent, { echoed: { value: 5 } });
    for (const invalid of [{ applyUploadMetadata: 'false' }, { source: 'other' }, { conflict: 'other' }, { path: 1 }, { surprise: true }]) {
      const rejected = await client.callTool({ name: 'upload_local_file', arguments: { localPath: 'wav-flac-metadata-source.wav', ...invalid } });
      assert.equal(rejected.isError, true);
    }
    assert.equal(creates, 0);
    const result = await client.callTool({ name: 'upload_local_file', arguments: { localPath: 'wav-flac-metadata-source.wav', applyUploadMetadata: true } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.upload.id, 'song');
    assert.equal(payload.metadata.ok, false);
    assert.match(payload.metadata.error, /scope denied/);
    assert.ok(uploaded > 0);
    assert.ok(Number(submittedTags?.duration) > 0);
    assert.ok(Number(submittedTags?.sampleRate) > 0);
    assert.ok(Number(submittedTags?.channels) > 0);
    assert.ok(Number(submittedTags?.bitDepth) > 0);
  } finally { await client.close(); await remote.close(); await new Promise<void>(resolve => http.close(() => resolve())); await rm(appdata, { recursive: true, force: true }); }
});

test('first stdio connection authorizes with OAuth and uploads a file', { timeout: 30_000 }, async () => {
  const { createRequire } = await import('node:module');
  const { createServer } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const require = createRequire(path.resolve('tools/mcp/package.json'));
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  const remote = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  const remoteTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => 'oauth-session', enableJsonResponse: true });
  let submitted: any;
  let uploaded = 0;
  remote.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ['create_upload', 'finish_upload', 'submit_upload_metadata', 'remote_echo'].map(name => ({ name, inputSchema: { type: 'object' } })) }));
  remote.setRequestHandler(CallToolRequestSchema, async ({ params }: any) => {
    if (params.name === 'submit_upload_metadata') submitted = params.arguments;
    const data = params.name === 'create_upload' ? { uploadId: 'ticket', uploadUrl: '/mcp/upload/ticket', method: 'PUT' } : params.name === 'finish_upload' ? { id: 'song' } : { ok: true };
    return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
  });
  await remote.connect(remoteTransport);
  let origin = '';
  let registeredCallback = '';
  let challenge = '';
  let tokenExchanges = 0;
  const http = createServer(async (req, res) => {
    const url = new URL(req.url!, origin);
    const json = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value)); };
    if (url.pathname.includes('oauth-protected-resource')) { res.writeHead(404).end(); return; }
    if (url.pathname.includes('oauth-authorization-server')) { json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] }); return; }
    if (url.pathname === '/register') {
      let body = ''; for await (const chunk of req) body += chunk;
      const registration = JSON.parse(body);
      registeredCallback = registration.redirect_uris[0];
      json({ client_id: 'fixture-client', redirect_uris: registration.redirect_uris }); return;
    }
    if (url.pathname === '/token') {
      let body = ''; for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      assert.equal(params.get('grant_type'), 'authorization_code');
      assert.equal(params.get('code'), 'fixture-code');
      assert.equal(params.get('redirect_uri'), registeredCallback);
      assert.equal(createHash('sha256').update(params.get('code_verifier')!).digest('base64url'), challenge);
      tokenExchanges++;
      json({ access_token: 'fixture-access', token_type: 'Bearer', refresh_token: 'fixture-refresh', expires_in: 3600 }); return;
    }
    if (req.headers.authorization !== 'Bearer fixture-access') { res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end(); return; }
    if (url.pathname === '/mcp/upload/ticket') { for await (const chunk of req) uploaded += chunk.length; json({ ok: true }); return; }
    await remoteTransport.handleRequest(req, res);
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(http.address() as any).port}`;
  const appdata = await mkdtemp(path.join(os.tmpdir(), 'edgesonic-first-auth-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [require.resolve('tsx/cli'), path.resolve('tools/mcp/main.ts')], stderr: 'pipe', env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', LOCALAPPDATA: appdata, EDGESONIC_URL: origin, EDGESONIC_LOCAL_ROOT: path.resolve('test/fixtures') } });
  const client = new Client({ name: 'test', version: '1.0.0' });
  let stderr = '';
  let authStarted = false;
  let callbackPort = 0;
  const authorize = new Promise<void>((resolve, reject) => {
    transport.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = stderr.match(/https?:\/\/[^\s]+\/authorize\?[^\s]+/);
      if (!match || authStarted) return;
      authStarted = true;
      try {
        const authUrl = new URL(match[0]);
        assert.equal(authUrl.origin, origin);
        assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
        challenge = authUrl.searchParams.get('code_challenge')!;
        const callback = new URL(authUrl.searchParams.get('redirect_uri')!);
        assert.equal(callback.href, registeredCallback);
        callbackPort = Number(callback.port);
        callback.searchParams.set('state', authUrl.searchParams.get('state')!);
        callback.searchParams.set('code', 'fixture-code');
        fetch(callback).then(response => { assert.equal(response.status, 200); resolve(); }, reject).catch(reject);
      } catch (error) { reject(error); }
    });
  });
  try {
    await Promise.all([client.connect(transport), authorize]);
    assert.equal(tokenExchanges, 1);
    assert.ok((await client.listTools()).tools.some((tool: any) => tool.name === 'remote_echo'));
    const result = await client.callTool({ name: 'upload_local_file', arguments: { localPath: 'wav-flac-metadata-source.wav', applyUploadMetadata: true } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(uploaded > 0);
    assert.equal(submitted.uploadId, 'ticket');
    assert.ok(Number(submitted.tags.duration) > 0);
    assert.deepEqual(Object.keys(submitted).sort(), ['tags', 'uploadId']);
    assert.doesNotMatch(stderr, /fixture-access|fixture-refresh/);
    const probe = createServer();
    await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(callbackPort, '127.0.0.1', resolve); });
    await new Promise<void>(resolve => probe.close(() => resolve()));
  } finally {
    await client.close();
    await remote.close();
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(appdata, { recursive: true, force: true });
  }
});
