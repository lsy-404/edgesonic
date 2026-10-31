# MCP setup

EdgeSonic provides a remote MCP endpoint at `/mcp` and a local stdio bridge. The bridge exposes the remote tools and adds local metadata search, file tag reading, and streaming uploads. It runs without the web interface. Local provider searches work without an EdgeSonic server.

From a source checkout, install the workspace dependencies with `pnpm install`. Configure your MCP client to launch the bridge with Node and the checkout's `tsx` CLI. For example, replace the paths with absolute paths on your computer:

```json
{
  "mcpServers": {
    "edgesonic": {
      "command": "node",
      "args": ["/path/to/edgesonic/tools/mcp/node_modules/tsx/dist/cli.mjs", "/path/to/edgesonic/tools/mcp/main.ts"],
      "env": {
        "EDGESONIC_URL": "https://your-edgesonic.example",
        "EDGESONIC_LOCAL_ROOT": "/path/to/music"
      }
    }
  }
}
```

Enable MCP in the EdgeSonic settings, then connect the bridge. On first connection, open the authorization URL printed to stderr and approve access in the browser. The bridge saves the resulting login credentials locally and refreshes them automatically. `EDGESONIC_URL` can be omitted for standalone local provider searches. Remote URLs require HTTPS, except for localhost. Local file operations require an explicitly configured `EDGESONIC_LOCAL_ROOT`; resolved paths and symbolic links must stay inside it. For Windows paths use JSON escaping, such as `C:\\Music`.

The additional local tools are:

- `search_metadata_local`: search providers directly from the local computer, optionally choosing sources.
- `resolve_metadata_local`: resolve a result returned by local search.
- `read_local_metadata`: read recognized tags from a local file.
- `upload_local_file`: stream a local file to the server. Set `applyUploadMetadata` to submit recognized local tags as part of the upload. The response reports upload and metadata submission separately, so an upload is not mistaken for a failure if metadata submission fails.

The bridge accepts upload tickets only for the configured server's `/mcp/upload/` endpoint and does not follow redirects. File deletion, when available, requires the corresponding remote permission.

## Remote tools and cloud queries

Run the protocol and permission tests with `pnpm run test:mcp`. The real local Worker smoke check is documented in `test/mcp-runtime/README.md`.

Remote tools include `search_library`, `get_metadata`, `get_album`, `list_files`, `get_song_files`, `search_metadata_candidates`, `resolve_metadata_candidate`, `update_metadata`, `batch_update_metadata`, `organize_files`, `create_folder`, `move_file`, `copy_file`, `move_folder`, `create_upload`, `finish_upload`, and `submit_upload_metadata`. They are listed according to both granted scopes and current EdgeSonic permissions. `delete_file` and `delete_folder` additionally require explicitly granted `mcp:delete`, delete permission, and an administrator account. Upload policy `overwrite` also requires deletion access; the default policy is `error`.

`organize_files` defaults to a preview (`dryRun: true`); set `dryRun: false` to apply. Single-file and directory moves use logical R2 paths. Template organization also supports WebDAV servers with MOVE support and refuses destination conflicts. Deletion is currently R2-only.

Cloud metadata queries also accept authenticated JSON `POST /mcp/metadata/search` with `{ "query": "artist title", "sources": ["lrc", "netease"], "limit": 10 }`, or `POST /mcp/metadata/resolve` with `{ "result": <candidate> }`. They require `mcp:read` and `edit_tags`, run on the server, and return provider errors alongside results. Queries never apply candidates automatically. Use `update_metadata` with selected fields, or `batch_update_metadata` for one patch across multiple tracks. Embedded tag write results are separate from catalog updates; currently MP3/FLAC up to 80 MiB on writable R2/WebDAV support rewriting.

Uploads use `create_upload` → authenticated PUT with the exact `Content-Length` → `finish_upload`. Tickets expire after one hour and permit one transfer. `submit_upload_metadata` accepts the upload ID and parsed fields, including duration and audio properties. The local bridge submits these when `applyUploadMetadata` is true. A queued upload metadata status is not complete until an executor processes it; metadata query tools themselves never need that executor.
