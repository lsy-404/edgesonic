# Deployment

The **recommended** way to deploy EdgeSonic: use the guided install wizard at
[deploy-edgesonic.wuyilingwei.com](https://deploy-edgesonic.wuyilingwei.com). No fork, no Actions tab, no
local toolchain — enter your Cloudflare credentials, pick a release, and the wizard deploys straight from
your browser to your own Cloudflare account.

> Deploying via an AI agent instead of a human? See [`DEPLOY_BY_AGENT.md`](DEPLOY_BY_AGENT.md) — it drives
> the same precompiled release package from a local `wrangler`, so the agent never has to run a build.

The Cloudflare API token and in-app update options are documented in [`WORKER_SELF_UPDATE.md`](WORKER_SELF_UPDATE.md).

## Guided installer (recommended)

The wizard walks through: welcome, entering and validating your Cloudflare credentials, choosing a
deployment target, picking a release, reviewing the plan, then running the deploy. Along the way it:

- validates your Cloudflare API token and account access before you commit to anything;
- checks whether R2 and Cloudflare Images are enabled on your account, and links straight to the
  Cloudflare dashboard page to turn them on if not, instead of failing partway through a deploy;
- lets you pick from the last 5 published releases that support the in-browser deploy path.

Because it deploys directly from your browser to your Cloudflare account with credentials you supply in
the moment, there's no fork to maintain and nothing to configure in the Actions tab.

The old fork-and-run-a-GitHub-Actions-workflow deploy path has been retired — the guided installer above
replaces it entirely, including automatic D1/R2 resource creation and cron schedule restoration
(`0 */1 * * *` by default, preserving whatever schedule was already live on an overwrite install). Local
development still uses `./deploy.sh` (see the main [README](../README.md#local-cli-deploy-development)),
which restores cron the same way when `CLOUDFLARE_API_TOKEN` is available.

### Publishing a release

The guided installer consumes releases produced by `.github/workflows/release.yml`. Push a `v*` tag (e.g.
`git tag v1.0.0 && git push origin v1.0.0`) or run **Actions → Release EdgeSonic → Run workflow** with a
tag. That job builds the frontend, assembles the self-contained package, and publishes it as a GitHub
Release asset — it needs **no** Cloudflare credentials. Mark a release as a *pre-release* on GitHub for it
to be picked up by the installer's prerelease channel.

## Cloudflare resource requirements

| Resource | Purpose | Free tier |
|----------|---------|-----------|
| Workers | Runtime | 100k req/day |
| D1 | Database (all state) | 5 GB storage, 25M row reads/day |
| R2 | Primary music storage | 10 GB storage, free egress |

All state uses D1 only. Feature flags, sessions, API keys, rate limits, last.fm cache, now playing, and cron timestamps all live in D1 with a 60-second per-isolate memory cache.
