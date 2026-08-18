# Worker Self-Update

## Conclusion

An in-app one-click update is technically possible when the Worker has a Cloudflare API token and account ID. It is not safe to add it by calling `wrangler` from the Worker: Wrangler is a build/deploy CLI and cannot run inside the Workers runtime.

The existing release package is not a direct Workers API upload. It contains `web/dist`, Worker source, migrations, configuration templates, and runtime dependencies. The release workflow now publishes a separate API-ready bundle with its own multipart metadata, asset manifest, binding declarations, and migration coordination.

## Supported Cloudflare API path

Cloudflare exposes two useful deployment flows:

1. Upload a complete module worker with `PUT /accounts/{account_id}/workers/scripts/{script_name}`. This uploads and deploys in one operation.
2. Create an immutable version with `POST /accounts/{account_id}/workers/scripts/{script_name}/versions`, then switch traffic with `POST /accounts/{account_id}/workers/scripts/{script_name}/deployments`.

The version-first flow is preferable because it allows validation before traffic is changed and gives the application a clear rollback target.

References:

- [Update a Worker script](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)
- [Create a Worker version](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/)
- [Create a Worker deployment](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/)
- [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)

## Recommended Options

### Workers Builds

Connect the deployment to GitHub through Cloudflare Workers Builds. A push to the configured repository branch triggers the build and deployment in Cloudflare. This keeps source checkout, dependency installation, bundling, assets, migrations, and deployment outside the running Worker.

This is the recommended production approach for this repository. It also avoids storing a GitHub token in a Worker Secret.

### Direct API updater

If the update button must live inside EdgeSonic, implement it as a privileged control-plane operation:

1. Fetch an allowlisted release manifest containing version, asset URL, checksum, and compatibility metadata. The current implementation verifies SHA-256 checksums; signature verification remains required before production use.
2. Download and verify a deployment-ready module artifact.
3. Upload it as a new Workers version using the Cloudflare API.
4. Run any explicitly compatible D1 migration before traffic switch.
5. Deploy the new version, poll its health/version endpoint, and retain the previous version for rollback.
6. Restore runtime-managed cron schedules after deployment.

The endpoint must be restricted to the Cloudflare-management permission, require a fresh confirmation, reject concurrent updates, enforce an allowlisted release source, and never return or log the API token.

## Why CF API token alone is insufficient for GitHub Actions

The existing deploy workflow downloads a GitHub Release, extracts it, creates or resolves D1/R2 resources, generates `wrangler.toml`, and runs Wrangler. A Cloudflare token can authorize Cloudflare API calls, but it cannot authenticate a GitHub workflow dispatch. Triggering that workflow from a Worker would require a separate GitHub token or GitHub App credential.

## Current Repository State

- `./deploy.sh` is the local Wrangler deployment path.
- The [guided installer](https://edgesonic-installer.demo-w10v.workers.dev) is the supported deploy path for everyone else — it
  replaced the old manual `deploy.yml` GitHub Actions workflow.
- `.github/workflows/release.yml` publishes the package and the direct Workers API module artifact.
- `worker/src/endpoints/edgesonic/cf.ts` already stores and uses `CF_API_TOKEN` for Cloudflare API operations.
- `CF_API_TOKEN` is used only inside the Worker for the protected self-update control plane; the current checksum-only artifact verification still needs a signed manifest for production hardening.

## In-App Update Interface

The implementation uses the existing `manage_cloudflare` permission and keeps the CF token inside the Worker:

- `GET /edgesonic/cf/getUpdates` lists release tags and selects the newest stable API-ready tag as `defaultTag`.
- `GET /edgesonic/cf/getUpdateStatus` reports the persisted operation state.
- `POST /edgesonic/cf/update` accepts `{ "tag": "v1.2.6", "confirmMajor": false }`. Omitting `tag` selects the newest stable release.

The release workflow publishes both the existing Wrangler package and an API-ready `edgesonic-update.tar.gz`. The latter contains a bundled `worker.js`, an assets manifest, static assets, and an optional `db/patch.sql`. The manifest contains the artifact checksum and Major-update declaration.

The default policy allows only newer versions within the current Major. A Major update requires both `allowMajorUpdate: true` in the selected release manifest and `confirmMajor: true` in the administrator request. Downgrades and same-version updates are rejected.
