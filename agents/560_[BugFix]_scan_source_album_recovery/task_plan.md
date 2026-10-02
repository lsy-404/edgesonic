# Scan source album recovery

## Goal
When a scan sees only a placeholder or codec-suffixed album name, recover the album name from one unambiguous logical source path and retain the source-folder identity. Keep usable existing album names and manual tag edits unchanged.

## Scope
- `worker/src/utils/albumIdentity.ts`
- scan entry points that currently derive album identity from incoming tags
- SQLite regression tests under `test/`

## Plan
- [x] Inspect scan identity and source path resolution.
- [x] Add scan-only source album recovery for placeholders and exact codec-suffixed folder names.
- [x] Add SQLite regressions for metadataApply, tag/read, and usable incoming album preservation.
- [x] Run targeted regression, worker typecheck, and diff checks.
- [ ] Commit the isolated change.
