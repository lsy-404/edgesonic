import { realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { parseStream } from 'music-metadata';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { LocalOAuthProvider } from './oauth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { searchMetadata, resolveMetadata } from '../../shared/scrape/local.js';

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });
const str = { type: 'string' };
const localTools = [
  { name: 'search_metadata_local', description: 'Search metadata providers directly from this computer.', inputSchema: schema({ query: str, sources: { type: 'array', items: str }, current: { type: 'object' }, limit: { type: 'integer', minimum: 1 } }, ['query']) },
  { name: 'resolve_metadata_local', description: 'Resolve a result from search_metadata_local.', inputSchema: schema({ result: { type: 'object' } }, ['result']) },
  { name: 'read_local_metadata', description: 'Read tags from a file under EDGESONIC_LOCAL_ROOT.', inputSchema: schema({ localPath: str }, ['localPath']) },
  { name: 'upload_local_file', description: 'Stream a local file to EdgeSonic; optionally submit its tags.', inputSchema: schema({ localPath: str, path: str, source: { enum: ['r2', 'webdav'] }, conflict: { enum: ['error', 'overwrite', 'rename'] }, applyUploadMetadata: { type: 'boolean' } }, ['localPath']) },
];

function validateLocalArguments(name: string, args: Record<string, unknown>) {
  const allowed: Record<string, string[]> = {
    search_metadata_local: ['query', 'sources', 'current', 'limit'],
    resolve_metadata_local: ['result'],
    read_local_metadata: ['localPath'],
    upload_local_file: ['localPath', 'path', 'source', 'conflict', 'applyUploadMetadata'],
  };
  const keys = allowed[name];
  if (!keys) return;
  if (Object.keys(args).some(key => !keys.includes(key))) throw new Error('Unexpected tool argument');
  if (name === 'read_local_metadata' || name === 'upload_local_file') {
    if (typeof args.localPath !== 'string' || !args.localPath) throw new Error('localPath must be a nonempty string');
  }
  if (name === 'upload_local_file') {
    if (args.path !== undefined && typeof args.path !== 'string') throw new Error('path must be a string');
    if (args.source !== undefined && args.source !== 'r2' && args.source !== 'webdav') throw new Error('Invalid source');
    if (args.conflict !== undefined && args.conflict !== 'error' && args.conflict !== 'overwrite' && args.conflict !== 'rename') throw new Error('Invalid conflict');
    if (args.applyUploadMetadata !== undefined && typeof args.applyUploadMetadata !== 'boolean') throw new Error('applyUploadMetadata must be a boolean');
  }
}
export async function openLocalFile(root: string | undefined, localPath: unknown) {
  if (!root) throw new Error('EDGESONIC_LOCAL_ROOT must be configured for local file access');
  if (typeof localPath !== 'string' || !localPath) throw new Error('localPath is required');
  const base = await realpath(root);
  const target = await realpath(path.resolve(base, localPath));
  const relative = path.relative(base, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Local file is outside EDGESONIC_LOCAL_ROOT');
  const file = await open(target, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Local path must be a regular file');
    return { file, stat, target };
  } catch (error) { await file.close(); throw error; }
}

export function uploadUrl(base: URL, raw: unknown, uploadId: unknown): URL {
  if (typeof raw !== 'string' || typeof uploadId !== 'string' || !uploadId) throw new Error('Invalid upload ticket');
  const url = new URL(raw, base);
  if (url.origin !== base.origin || url.username || url.password || url.hash || url.search || url.pathname !== `/mcp/upload/${encodeURIComponent(uploadId)}`) throw new Error('Invalid upload URL');
  return url;
}

async function tagsFromFile(file: Awaited<ReturnType<typeof openLocalFile>>['file'], size: number) {
  const stream = file.createReadStream({ start: 0, autoClose: false });
  try {
    const { common, format } = await parseStream(stream, { size }, { skipCovers: true });
    const tags = { duration: format.duration, bitrate: format.bitrate === undefined ? undefined : format.bitrate / 1000, sampleRate: format.sampleRate, bitDepth: format.bitsPerSample, channels: format.numberOfChannels, container: format.container, codec: format.codec, title: common.title, artist: common.artist, album: common.album, albumArtist: common.albumartist, year: common.year, genre: common.genre?.join(', '), track: common.track?.no ?? undefined, disc: common.disk?.no ?? undefined, lyrics: common.lyrics?.map(item => item.text).filter(Boolean).join('\n') || undefined };
    return { tags: Object.fromEntries(Object.entries(tags).filter(([, value]) => value !== undefined && value !== '')), format };
  } finally { stream.destroy(); }
}

function resultData(result: any): any {
  if (result.isError) throw new Error(result.content?.map((part: any) => part.text).filter(Boolean).join('\n') || 'Remote tool failed');
  if (result.structuredContent) return result.structuredContent;
  const value = result.content?.find((part: any) => part.type === 'text')?.text;
  if (!value) throw new Error('Remote tool returned no data');
  return JSON.parse(value);
}

export async function start() {
  const url = process.env.EDGESONIC_URL;
  let auth: LocalOAuthProvider | undefined;
  let remote: Client | undefined;
  let base: URL | undefined;
  let remoteTransport: StreamableHTTPClientTransport | undefined;
  if (url) {
    base = new URL(url);
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid EDGESONIC_URL');
    if (base.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('EDGESONIC_URL must use HTTPS except on localhost');
    const endpoint = new URL('/mcp', base);
    remote = new Client({ name: 'edgesonic-local', version: '1.0.0' });
    auth = await LocalOAuthProvider.create(base.origin);
    await auth.prepare();
    const guardedFetch: typeof fetch = (input, init) => {
      const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (target.origin !== base!.origin) throw new Error('OAuth endpoint must use the EdgeSonic origin');
      return fetch(input, { ...init, redirect: 'error' });
    };
    const transport = new StreamableHTTPClientTransport(endpoint, { authProvider: auth, fetch: guardedFetch });
    remoteTransport = transport;
    try {
      try { await remote.connect(transport); }
      catch (error) {
        if (!(error instanceof UnauthorizedError)) throw error;
        await transport.finishAuth(await auth.authorizationCode());
        remote = new Client({ name: 'edgesonic-local', version: '1.0.0' });
        remoteTransport = new StreamableHTTPClientTransport(endpoint, { authProvider: auth, fetch: guardedFetch });
        await remote.connect(remoteTransport);
      }
    } finally { await auth.close(); }
  }
  let authorization: Promise<void> | undefined;
  async function authorized<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (!(error instanceof UnauthorizedError) || !auth || !remoteTransport) throw error;
      authorization ??= (async () => { try { await remoteTransport!.finishAuth(await auth!.authorizationCode()); } finally { await auth!.close(); } })().finally(() => { authorization = undefined; });
      await authorization;
      return operation();
    }
  }
  const server = new Server({ name: 'edgesonic-local', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.onclose = () => { void auth?.close(); void remote?.close(); };
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [...localTools];
    if (remote) {
      let cursor: string | undefined;
      do { const page = await authorized(() => remote!.listTools({ cursor }, { timeout: 120_000 })); tools.push(...page.tools.filter(tool => !localTools.some(local => local.name === tool.name)) as typeof localTools); cursor = page.nextCursor; } while (cursor);
    }
    return { tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const args = params.arguments ?? {};
    try {
      validateLocalArguments(params.name, args);
      if (params.name === 'search_metadata_local') return text(await searchMetadata(args as unknown as Parameters<typeof searchMetadata>[0]));
      if (params.name === 'resolve_metadata_local') return text(await resolveMetadata(args as unknown as Parameters<typeof resolveMetadata>[0]));
      if (params.name === 'read_local_metadata' || params.name === 'upload_local_file') {
        const opened = await openLocalFile(process.env.EDGESONIC_LOCAL_ROOT, args.localPath);
        try {
          if (params.name === 'read_local_metadata') return text(await tagsFromFile(opened.file, opened.stat.size));
          if (!remote || !base || !auth) throw new Error('Remote EdgeSonic is not configured');
          let parsed: Awaited<ReturnType<typeof tagsFromFile>> | undefined;
          if (args.applyUploadMetadata) {
            const metadataFile = await openLocalFile(process.env.EDGESONIC_LOCAL_ROOT, args.localPath);
            try { parsed = await tagsFromFile(metadataFile.file, metadataFile.stat.size); } finally { await metadataFile.file.close(); }
          }
          const ticket = resultData(await authorized(() => remote!.callTool({ name: 'create_upload', arguments: { name: path.basename(opened.target), size: opened.stat.size, ...(args.path !== undefined ? { path: args.path } : {}), ...(args.source !== undefined ? { source: args.source } : {}), ...(args.conflict !== undefined ? { conflict: args.conflict } : {}) } }, undefined, { timeout: 120_000 })));
          const destination = uploadUrl(base, ticket.uploadUrl, ticket.uploadId);
          if (ticket.method !== 'PUT') throw new Error('Invalid upload method');
          await authorized(() => remote!.listTools(undefined, { timeout: 120_000 }));
          const token = (await auth.tokens())?.access_token;
          if (!token) throw new Error('Remote authorization is unavailable');
          const stream = opened.file.createReadStream({ start: 0, autoClose: false });
          let response: Response;
          try { response = await fetch(destination, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Length': String(opened.stat.size), 'Content-Type': 'application/octet-stream' }, body: Readable.toWeb(stream) as any, duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(1_800_000) } as RequestInit); } finally { stream.destroy(); }
          if (!response.ok) throw new Error(`Upload failed: HTTP ${response.status}`);
          const uploaded = resultData(await authorized(() => remote!.callTool({ name: 'finish_upload', arguments: { uploadId: ticket.uploadId } }, undefined, { timeout: 120_000 })));
          if (!args.applyUploadMetadata) return text({ upload: uploaded });
          try {
            const metadata = resultData(await authorized(() => remote!.callTool({ name: 'submit_upload_metadata', arguments: { uploadId: ticket.uploadId, tags: parsed!.tags } }, undefined, { timeout: 120_000 })));
            return text({ upload: uploaded, metadata: { ok: true, result: metadata } });
          } catch (error) { return text({ upload: uploaded, metadata: { ok: false, error: String(error) } }); }
        } finally { await opened.file.close(); }
      }
      if (!remote) throw new Error('Remote EdgeSonic is not configured');
      return await authorized(() => remote!.callTool(params, undefined, { timeout: 120_000 }));
    } catch (error) { return { ...text({ error: error instanceof Error ? error.message : String(error) }), isError: true }; }
  });
  await server.connect(new StdioServerTransport());
}
