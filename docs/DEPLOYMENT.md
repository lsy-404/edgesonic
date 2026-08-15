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

## Advanced: manual GitHub Actions deploy

Prefer a fork-based, credential-as-workflow-input flow, or want deploys triggered from CI instead of a
browser? The workflow at `.github/workflows/deploy.yml` is **manual-only** (no automatic push trigger).
Instead of building from source, it **downloads a precompiled release package** (prebuilt `web/dist` +
isolated `worker/node_modules`) published by `.github/workflows/release.yml`, then deploys it with
`wrangler`. All credentials are supplied as workflow inputs each time — the repository itself stores
nothing.

D1 databases and R2 buckets that do not yet exist are **automatically created and bound** during the run.

### Prerequisites

1. **Fork** this repository (deploys run from your fork's Actions tab).
2. A **Cloudflare API token** ([dash.cloudflare.com → API Tokens](https://dash.cloudflare.com/profile/api-tokens) → *Create Token*) with `Workers Scripts:Edit`, `D1:Edit`, and `Workers R2 Storage:Edit`, plus your **Account ID**.

No local Node.js or Wrangler install is needed — everything runs on the GitHub-hosted runner.

### How to deploy

Go to **Actions → Deploy EdgeSonic → Run workflow** and fill in:

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `cf_api_token` | ✅ | — | CF API token (Workers:Edit + D1:Edit + R2:Edit) |
| `cf_account_id` | ✅ | — | Cloudflare Account ID |
| `release_channel` | ✅ | `stable` | Which release to deploy: `stable` (latest non-prerelease) or `prerelease` (latest prerelease) |
| `release_tag` | optional | — | Pin an exact release tag (e.g. `v1.0.0`); overrides `release_channel` when set |
| `source_repo` | optional | `wuyilingwei/edgesonic` | Repo to download the release from. Leave as-is to pull the upstream release; change it only if your fork publishes its own |
| `worker_name` | optional | `edgesonic` | Worker script name |
| `d1_database_name` | optional | `edgesonic-db` | D1 database (auto-created if absent) |
| `r2_bucket_name` | optional | `edgesonic-music` | R2 bucket (auto-created if absent) |
| `domain` | optional | — | Custom domain; leave empty for `<worker>.workers.dev` |
| `instance_id` | optional | — | Anti-loop UUID; auto-generated when blank |

The workflow verifies the package checksum and embedded build metadata before extracting, so a corrupted, incomplete, or mismatched release fails before deployment.

### Publishing a release

Both the guided installer and the manual Actions flow consume releases produced by
`.github/workflows/release.yml`. Push a `v*` tag (e.g. `git tag v1.0.0 && git push origin v1.0.0`) or run
**Actions → Release EdgeSonic → Run workflow** with a tag. That job builds the frontend, assembles the
self-contained package, and publishes it as a GitHub Release asset — it needs **no** Cloudflare
credentials. Mark a release as a *pre-release* on GitHub for it to be picked up by the `prerelease`
channel.

### Cron recovery

The GitHub Action restores the default cron schedule (`0 */1 * * *`) after deployment and fails if that restoration fails. Local `./deploy.sh` restores it when `CLOUDFLARE_API_TOKEN` is available. A direct `wrangler deploy` clears dynamic cron schedules; restore them from **Settings → Cloudflare → "Ensure default cron"** after configuring the Cloudflare API token.

## Cloudflare resource requirements

| Resource | Purpose | Free tier |
|----------|---------|-----------|
| Workers | Runtime | 100k req/day |
| D1 | Database (all state) | 5 GB storage, 25M row reads/day |
| R2 | Primary music storage | 10 GB storage, free egress |

All state uses D1 only. Feature flags, sessions, API keys, rate limits, last.fm cache, now playing, and cron timestamps all live in D1 with a 60-second per-isolate memory cache.
