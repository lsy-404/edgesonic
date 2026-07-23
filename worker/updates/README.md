# Release Database Patches

Optional incremental patches for the in-app Worker updater live here.

Name a patch after the release tag, for example `v1.3.0.sql`. The release
workflow includes that file in the API-ready artifact and records its SHA-256
in the update manifest. The updater applies a patch at most once, before the
new Worker version is deployed.

Patches must be additive and backward-compatible with the currently deployed
Worker. Do not include transaction-control statements or `PRAGMA`, `ATTACH`,
`DETACH`, `VACUUM`, or `DROP`.
