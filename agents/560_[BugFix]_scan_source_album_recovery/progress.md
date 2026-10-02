# Progress

- Created an isolated worktree at the approved task path, based on current local main.
- Updated `worker/src/utils/albumIdentity.ts`, `worker/src/utils/metadataApply.ts`, and `worker/src/endpoints/tag/read.ts` to recover a source album name and source-folder ID only for generic or exact codec-suffixed current values.
- Added SQLite-backed tests in `test/internal/album_artist_roundtrip.test.ts` for unknown album recovery, codec-suffixed recovery, preserving real incoming titles, and the actual `/tag/read` route.
- Targeted album artist roundtrip: PASS.
- `npm run typecheck -w worker`: PASS.
- `git diff --check`: PASS.
- Next: commit only the isolated change.
# Progress

- First isolated implementation was reviewed against a mixed source-folder cohort; it now reuses the sole existing album with the recovered canonical name in the same source folder, rather than creating a new folder hash.
- Source album lookups run only when the current album is a generic placeholder or exact codec-suffixed label. Usable album names do not trigger this lookup.
- Added an SQLite regression where a generic track shares its folder with a correctly named album, plus preserved existing quote/NFD, compilation, changed album, changed album artist, and manual tag write cases.
- Targeted `album_artist_roundtrip.test.ts`: PASS.
- `npm run typecheck -w worker`: PASS.
- `git diff --check`: PASS.
- The first commit remains `0ad594475cd999544758a9b72f05cfeed9eeba14`; review corrections are a separate follow-up commit.
