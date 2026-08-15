# EdgeSonic Installer Relay

A small standalone Cloudflare Worker that lets the guided installer (a static GitHub Pages site) talk to
`api.cloudflare.com` from the browser. Cloudflare's API sends no `Access-Control-Allow-*` headers on any
method, so a static page can't call it directly — this Worker forwards an allow-listed set of Cloudflare
API calls and adds CORS headers instead. It is deployed once on the project's own Cloudflare account; an
end user running the installer never sets this up themselves. See [`CONTRACT.md`](./CONTRACT.md) for the
full spec: the exact endpoint allowlist, the R2 key-verification design, and the CORS/size-limit policy.

## Local development

```bash
cp wrangler.toml.example wrangler.toml
# edit wrangler.toml: set account_id and ALLOWED_ORIGINS
npm install
npx wrangler dev
```

## Origin allowlist

`ALLOWED_ORIGINS` is a comma-separated, exact-match list of installer origins allowed to read this
relay's responses (no wildcards). Set it as a `[vars]` entry in `wrangler.toml`, or push it as a Worker
secret (`wrangler secret put ALLOWED_ORIGINS`) to change it without a redeploy. In CI, the
`deploy-relay.yml` workflow takes it as a manual `workflow_dispatch` input.
