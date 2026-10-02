# Progress

- Created an isolated worktree at the approved task path, based on current local main.
- Updated `worker/src/utils/albumIdentity.ts`, `worker/src/utils/metadataApply.ts`, and `worker/src/endpoints/tag/read.ts` to recover a source album name and source-folder ID only for generic or exact codec-suffixed current values.
- Added SQLite-backed tests in `test/internal/album_artist_roundtrip.test.ts` for unknown album recovery, codec-suffixed recovery, preserving real incoming titles, and the actual `/tag/read` route.
- Targeted album artist roundtrip: PASS.
- `npm run typecheck -w worker`: PASS.
- `git diff --check`: PASS.
- Next: commit only the isolated change.
