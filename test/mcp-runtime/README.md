# Local MCP runtime check

Run these commands from the repository root. They use the local D1 and R2 simulators, with no KV binding or configured signing key.

```sh
pnpm exec wrangler d1 execute mcp-test --local --config test/mcp-runtime/wrangler.jsonc --file worker/migrations/Schema.sql
pnpm exec wrangler d1 execute mcp-test --local --config test/mcp-runtime/wrangler.jsonc --file test/mcp-runtime/seed.sql
pnpm exec wrangler dev --local --config test/mcp-runtime/wrangler.jsonc --port 8796
```

With the server ready, run `node test/mcp-runtime/smoke.mjs` in another terminal. It verifies that MCP starts disabled, enables it through settings, registers an OAuth client, and exercises upload, metadata submission/read/write, logical move, organization preview, deletion denial, and grant revocation through the real Worker. It disables MCP at the end. Test media remains in local storage. The seeded session is for local testing only.
