# Rate limiting bindings

`wrangler.toml.example` declares two independent Cloudflare Rate Limiting API
bindings:

- `AUTH_RATE_LIMITER`: 20 calls per 60 seconds for login and registration.
- `API_RATE_LIMITER`: 1200 calls per 60 seconds for the authenticated API.

The example uses `140001` and `140002` as positive-integer namespace IDs. Before a
real deployment, replace them in the ignored `worker/wrangler.toml` with two
IDs that are unique in your Cloudflare account. Keeping the IDs different keeps
the counters independent. The binding only becomes effective when Worker code
calls its `limit({ key })` method.

Create or refresh the local configuration with:

```bash
cp worker/wrangler.toml.example worker/wrangler.toml
```

Do not commit `worker/wrangler.toml`; it is ignored because it contains private
resource identifiers.
