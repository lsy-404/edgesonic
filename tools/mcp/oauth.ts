import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

type Stored = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; redirectUrl?: string };

export class LocalOAuthProvider implements OAuthClientProvider {
  private stored: Stored = {};
  private verifier = '';
  private readonly nonce = randomBytes(32).toString('base64url');
  private listener?: Server;
  private callback?: Promise<string>;
  private redirect = '';
  private constructor(private readonly file: string, private readonly origin: string) {}

  static async create(origin: string, directory = path.join(process.env.LOCALAPPDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')), 'EdgeSonic', 'mcp')) {
    const provider = new LocalOAuthProvider(path.join(directory, `${createHash('sha256').update(new URL(origin).origin).digest('hex')}.json`), new URL(origin).origin);
    try { provider.stored = JSON.parse(await readFile(provider.file, 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    return provider;
  }
  get redirectUrl() { return this.redirect; }
  get clientMetadata() { return { client_name: 'EdgeSonic local bridge', redirect_uris: [this.redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' as const, scope: 'mcp:read mcp:upload mcp:write mcp:delete' }; }
  state() { return this.nonce; }
  clientInformation() { return this.stored.client; }
  tokens() { return this.stored.tokens; }
  async saveClientInformation(client: OAuthClientInformationMixed) { this.stored.client = client; this.stored.redirectUrl = this.redirect; await this.save(); }
  async saveTokens(tokens: OAuthTokens) { this.stored.tokens = tokens; await this.save(); }
  saveCodeVerifier(verifier: string) { this.verifier = verifier; }
  codeVerifier() { if (!this.verifier) throw new Error('Missing OAuth verifier'); return this.verifier; }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') { if (scope === 'all' || scope === 'client') delete this.stored.client; if (scope === 'all' || scope === 'tokens') delete this.stored.tokens; if (scope === 'all' || scope === 'verifier') this.verifier = ''; await this.save(); }
  private async save() { await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 }); if (process.platform !== 'win32') await chmod(path.dirname(this.file), 0o700); await writeFile(this.file, JSON.stringify(this.stored), { mode: 0o600 }); if (process.platform !== 'win32') await chmod(this.file, 0o600); }
  async prepare() {
    const previous = this.stored.redirectUrl ? new URL(this.stored.redirectUrl) : undefined;
    const port = previous?.hostname === '127.0.0.1' && previous.pathname === '/callback' ? Number(previous.port) : 0;
    this.listener = createServer();
    const listen = (selected: number) => new Promise<void>((resolve, reject) => { this.listener!.once('error', reject); this.listener!.listen(selected, '127.0.0.1', () => { this.listener!.off('error', reject); resolve(); }); });
    try { await listen(port); } catch (error: any) { if (error.code !== 'EADDRINUSE' || !port) throw error; await listen(0); }
    this.listener.unref();
    this.redirect = `http://127.0.0.1:${(this.listener.address() as any).port}/callback`;
    if (this.stored.redirectUrl !== this.redirect) { delete this.stored.client; delete this.stored.tokens; }
  }
  async redirectToAuthorization(url: URL) {
    if (url.origin !== this.origin) throw new Error('OAuth authorization endpoint must use the EdgeSonic origin');
    if (!this.listener) {
      this.listener = createServer();
      await new Promise<void>((resolve, reject) => { this.listener!.once('error', reject); this.listener!.listen(Number(new URL(this.redirect).port), '127.0.0.1', () => { this.listener!.off('error', reject); resolve(); }); });
      this.listener.unref();
    }
    if (this.callback) throw new Error('OAuth authorization already pending');
    this.callback = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('OAuth authorization timed out')); }, 300_000);
      const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
        const callback = new URL(req.url || '/', this.redirect);
        if (req.method !== 'GET' || callback.pathname !== '/callback') { res.writeHead(404).end(); return; }
        if (callback.searchParams.get('state') !== this.nonce || callback.searchParams.getAll('state').length !== 1) { res.writeHead(400).end('Invalid state'); return; }
        const code = callback.searchParams.get('code');
        if (!code || callback.searchParams.getAll('code').length !== 1) { res.writeHead(400).end('Authorization failed'); cleanup(); reject(new Error('OAuth authorization failed')); return; }
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Authorization complete. You may close this window.'); cleanup(); resolve(code);
      };
      const cleanup = () => { clearTimeout(timer); this.listener?.off('request', handler); };
      this.listener!.on('request', handler);
    });
    process.stderr.write(`Open this URL to authorize EdgeSonic:\n${url.href}\n`);
  }
  async authorizationCode() { if (!this.callback) throw new Error('OAuth authorization was not started'); try { return await this.callback; } finally { this.callback = undefined; } }
  async close() { const listener = this.listener; this.listener = undefined; if (listener) await new Promise<void>(resolve => listener.close(() => resolve())); }
}
