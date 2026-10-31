# MCP setup

EdgeSonic provides a remote MCP endpoint at `/mcp` and a local stdio bridge. The bridge exposes the remote tools and adds local metadata search, file tag reading, and streaming uploads. It runs without the web interface. Local provider searches work without an EdgeSonic server or token.

From a source checkout, install the workspace dependencies with `pnpm install`. Configure your MCP client to launch the bridge with Node and the checkout's `tsx` CLI. For example, replace the paths with absolute paths on your computer:

```json
{
  "mcpServers": {
    "edgesonic": {
      "command": "node",
      "args": ["/path/to/edgesonic/tools/mcp/node_modules/tsx/dist/cli.mjs", "/path/to/edgesonic/tools/mcp/main.ts"],
      "env": {
        "EDGESONIC_URL": "https://your-edgesonic.example",
        "EDGESONIC_MCP_TOKEN": "YOUR_SCOPED_TOKEN",
        "EDGESONIC_LOCAL_ROOT": "/path/to/music"
      }
    }
  }
}
```

For a Windows path use JSON escaping, such as `C:\\Music`. The token is passed through the environment, never command-line arguments. Store client configuration securely. `EDGESONIC_URL` and `EDGESONIC_MCP_TOKEN` must be supplied together; omit both for local provider searches. Remote URLs require HTTPS, except for localhost. The token must have the scopes required by each remote operation. Local file operations require an explicitly configured `EDGESONIC_LOCAL_ROOT`; resolved paths and symbolic links must stay inside it.

The additional local tools are:

- `search_metadata_local`: search providers directly from the local computer, optionally choosing sources.
- `resolve_metadata_local`: resolve a result returned by local search.
- `read_local_metadata`: read recognized tags from a local file.
- `upload_local_file`: stream a local file to the server. Set `applyUploadMetadata` to submit recognized local tags as part of the upload. The response reports upload and metadata submission separately, so an upload is not mistaken for a failure if metadata submission fails.

The bridge connects to the remote endpoint using the supplied bearer token. It accepts upload tickets only for the configured server's `/mcp/upload/` endpoint and does not follow redirects. File deletion, when available, requires the corresponding remote permission.
## Obtain and renew a token

Use an OAuth-capable API client that supports dynamic client registration, authorization code with PKCE, and exporting its access token. Configure the server origin as the authorization server and `/mcp` as the resource. Its discovery document is `/.well-known/oauth-authorization-server`; registration is at `/oauth/register`. Choose a loopback callback supported by the client and register that exact redirect URI. Configure a public client with `token_endpoint_auth_method` set to `none`, and use PKCE `S256`.

Sign in to EdgeSonic in the browser, then start authorization in the API client. It opens `/authorize`; approve the required scopes (`mcp:read`, plus `mcp:upload`, `mcp:write`, or `mcp:delete` as needed). The client receives the authorization code at its loopback callback and exchanges it at `/oauth/token` using its original PKCE verifier. Copy the resulting **access token** into the MCP client's protected environment configuration as `EDGESONIC_MCP_TOKEN` and restart the bridge. Do not put tokens in command arguments, shared configuration, or logs.

The bridge reads a static token at startup and does not refresh it. When it expires, use the OAuth client's refresh operation or authorize again, replace the environment value, and restart the bridge. Keep any refresh token in the OAuth client's secure storage. A deployment must configure `MCP_OAUTH_KV`. An authenticated session can inspect grants at `GET /edgesonic/mcp/grants` and revoke them with `POST /edgesonic/mcp/grants/revoke`.

Create a dedicated Workers KV namespace and bind it as `MCP_OAUTH_KV`; see `worker/wrangler.toml.example`. Without this binding, MCP and its OAuth routes return 503. Existing application routes remain available. Revocations may take time to propagate between Cloudflare regions.

## Remote tools and cloud queries

Run the protocol and permission tests with `pnpm run test:mcp`. The real local Worker smoke check is documented in `test/mcp-runtime/README.md`.

Remote tools include `search_library`, `get_metadata`, `get_album`, `list_files`, `get_song_files`, `search_metadata_candidates`, `resolve_metadata_candidate`, `update_metadata`, `batch_update_metadata`, `organize_files`, `create_folder`, `move_file`, `copy_file`, `move_folder`, `create_upload`, `finish_upload`, and `submit_upload_metadata`. They are listed according to both granted scopes and current EdgeSonic permissions. `delete_file` and `delete_folder` additionally require explicitly granted `mcp:delete`, delete permission, and an administrator account. Upload policy `overwrite` also requires deletion access; the default policy is `error`.

`organize_files` defaults to a preview (`dryRun: true`); set `dryRun: false` to apply. Single-file and directory moves use logical R2 paths. Template organization also supports WebDAV servers with MOVE support and refuses destination conflicts. Deletion is currently R2-only.

Cloud metadata queries also accept authenticated JSON `POST /mcp/metadata/search` with `{ "query": "artist title", "sources": ["lrc", "netease"], "limit": 10 }`, or `POST /mcp/metadata/resolve` with `{ "result": <candidate> }`. They require `mcp:read` and `edit_tags`, run on the server, and return provider errors alongside results. Queries never apply candidates automatically. Use `update_metadata` with selected fields, or `batch_update_metadata` for one patch across multiple tracks. Embedded tag write results are separate from catalog updates; currently MP3/FLAC up to 80 MiB on writable R2/WebDAV support rewriting.

Uploads use `create_upload` → authenticated PUT with the exact `Content-Length` → `finish_upload`. Tickets expire after one hour and permit one transfer. Set the existing `WORK_UPLOAD_HMAC_KEY` Worker Secret to at least 32 random bytes to enable direct metadata submission. `submit_upload_metadata` accepts the returned instance `id`, `metadataToken`, and parsed fields, including duration and audio properties. The local bridge submits these when `applyUploadMetadata` is true. A queued upload metadata status is not complete until an executor processes it; metadata query tools themselves never need that executor.
