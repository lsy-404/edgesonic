# Rate limiting bindings

`wrangler.toml.example` declares two independent Cloudflare Rate Limiting API
bindings:

- `AUTH_RATE_LIMITER`: 20 calls per 60 seconds for each login or registration
  device and normalized username.
- `API_RATE_LIMITER`: 1200 calls per 60 seconds for each authenticated user and
  server-issued session, Subsonic credential, or API key identity.

Cloudflare maintains each key's counter independently in every location that
runs the Worker. That location boundary supplies the regional dimension; the
application key supplies the user and device dimensions. It is intentionally
not a single account-wide request budget.

Raw session tokens, Subsonic passwords, and API keys are never passed to the
binding. The Worker derives a short SHA-256 identifier first. Browser login and
registration use a random first-party browser identifier; clients without that
header fall back to a digest of their Cloudflare client IP and user-agent data.
The D1 failed-login lock remains independent of this approximate edge limit.

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
