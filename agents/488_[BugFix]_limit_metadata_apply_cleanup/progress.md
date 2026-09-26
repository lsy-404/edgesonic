# Progress

- Created an isolated worktree on `codex/metadata-apply-cleanup`; main checkout was not changed.
- Updated `metadataApply.ts` to collect displaced artist IDs and delete only candidates that no longer have song, album-artist, or song-credit references; album deletion now targets only the vacated old ID.
- Added `idx_songmasters_album_artist` to the canonical schema and migration `0041_songmaster_album_artist_index.sql`.
- Extended `test/internal/work_submit_apply_metadata.test.ts` with cleanup scope, preserved-reference, and query-plan assertions.
- `npx tsx test/internal/work_submit_apply_metadata.test.ts`: PASS.
- `npm run typecheck -w worker`: PASS.
- `git diff --check`: PASS.
- `npm ci` was needed in the isolated checkout; patch-package reported the existing `music-metadata` patch targets 11.13.0 while lockfile installed 11.15.0, but applied successfully. This was not changed as part of the task.
