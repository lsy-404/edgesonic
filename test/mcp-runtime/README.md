# Local MCP runtime check

Run these commands from the repository root. They use local D1, KV and R2 resources only.

```sh
pnpm exec wrangler d1 execute mcp-test --local --config test/mcp-runtime/wrangler.jsonc --file worker/migrations/Schema.sql
pnpm exec wrangler d1 execute mcp-test --local --config test/mcp-runtime/wrangler.jsonc --file test/mcp-runtime/seed.sql
pnpm exec wrangler dev --local --config test/mcp-runtime/wrangler.jsonc --port 8796
```

With the server ready, run `node test/mcp-runtime/smoke.mjs` in another terminal. It registers a local OAuth client and exercises upload, metadata submission/read/write, logical move, organization preview, deletion denial, and grant revocation through the real Worker. Test media remains in the local simulated storage. The fixture session and signing key are for local testing only.
