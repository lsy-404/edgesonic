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
