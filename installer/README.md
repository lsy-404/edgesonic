# EdgeSonic Installer

A guided, browser-based deployment wizard for EdgeSonic: paste Cloudflare credentials, pick a release,
and get a running instance without touching `wrangler` or the GitHub Actions tab.

This is a single Cloudflare Worker with two halves:

- **Frontend** (`src/`) — the Vue 3 wizard: credential validation, R2/Images enablement checks, release
  selection, and the fresh/overwrite install flow. Built with Vite into `dist/`.
- **Backend** (`worker/`) — a small Hono app serving that built frontend (via the `ASSETS` binding) and
  an allow-listed CORS relay to `api.cloudflare.com`, which sends no CORS headers of its own so the wizard
  can't call it directly otherwise. Same origin as the frontend, so the wizard's own calls never need
  CORS — see [`CONTRACT.md`](./CONTRACT.md) for the full route allowlist, the R2 key-verification design,
  and why CORS support stays on anyway (a separately-hosted frontend fork can still reach this backend,
  gated by the `ALLOWED_ORIGINS` allowlist).

## Local development

Two processes, both from `installer/`:

```bash
cp wrangler.toml.example wrangler.toml
# edit wrangler.toml: set account_id, and ALLOWED_ORIGINS if you need cross-origin access
npm install

npx wrangler dev      # backend, port 8787
npm run dev           # frontend, port 5174 — proxies /cf and /r2 to :8787 (see vite.config.ts)
```

Open `http://localhost:5174`.

## Deploy

```bash
npm run build          # -> dist/
npx wrangler deploy
```

This is project infrastructure, deployed once on the project's own Cloudflare account — an end user
running the installer never sets this up themselves.

## Origin allowlist

`ALLOWED_ORIGINS` is a comma-separated, exact-match list of *other* origins allowed to call this Worker's
`/cf` and `/r2` routes cross-origin (no wildcards). Set it as a `[vars]` entry in `wrangler.toml`, or push
it as a Worker secret (`wrangler secret put ALLOWED_ORIGINS`) to change it without a redeploy.
