# Findings

## Scope
Implement a curated, display-only relationship among original album rows. Preserve `albums.id`, `song_masters.album_id`, instances, source paths, artist/song relations, cover pointers, and all existing annotations/references. Keep Subsonic album list/detail and compilation handling unchanged.

## Initial design constraints
- Explicit membership only; do not infer groups from title, artist, source path, track overlap, or `albums.compilation`.
- The Library list may project grouped cards; opening one must show member editions and then call the existing original-ID album detail flow.
- Album-pruning lifecycle must remove stale group presentation metadata without changing remaining album data.
- All tests stay under repository-root `/test`.

## Investigation / errors

## Implementation decision
- Migration `0042_album_display_groups.sql` adds a curated group table and a member relation. `album_id` is unique across groups, member order is explicit, and both relations cascade on group/album deletion.
- Migration is schema-only; it contains no media-specific group, album, or source IDs. Curated membership must be populated through a separate exact-ID guarded data operation after fresh primary preflight.
- A `BEFORE DELETE` album trigger removes all members and group metadata if any member album is pruned. This prevents a partial group from being displayed; remaining original albums are untouched.
- EdgeSonic-only `GET /edgesonic/album-display-groups` and `GET /edgesonic/album-display-groups/:id` require `browse`. Group detail returns each original album ID and its existing cover/artist/year/count metadata. The Subsonic endpoints are unchanged.
- The main Library album grid folds fetched album pages only when the stable first member (`memberAlbumIds[0]`) arrives. Earlier non-anchor pages hide that edition without prematurely rendering the group card; the full album pages remain accumulated, so the card appears once at the anchor's sorted position. Group detail fetches all member editions. Starred lists, artist albums, search results, Subsonic clients, stars, shares, and detail behavior stay album-scoped. Selecting an edition uses the existing album-ID detail flow.
- Compilation flags and `retainCompilationAlbum` are untouched.

## Verification
- `npx tsx --test test/internal/album_display_groups.test.ts` and `npx tsx --test test/frontend/album_display_groups.test.ts`: each passes. The server test executes the real migration in SQLite, adds generic local-only group fixtures, exercises both read routes, checks ordering/original IDs, uniqueness, missing group behavior, and group invalidation on album pruning. The UI projection test covers page-split memberships, stable anchor rendering, single-card behavior, and preserving ungrouped albums.
- Wrangler 4.128.0 local D1 applied `test/fixtures/album_display_groups_wrangler_base.sql` and migration `0042_album_display_groups.sql` successfully; the schema initially had no groups. A separate test-only fixture then populated generic groups and a follow-up query returned Group A with 4 members and Group B with 5. All commands used `--local`; no remote D1 access occurred.
- `npm run typecheck -w worker`: pass.
- `npm run typecheck -w web`: pass.
- `npm run build:web`: pass. Vite emitted its existing url externalization and >500 KB chunk warnings.

## Investigation / errors
- Initial test/typecheck calls failed because dependencies were absent in this worktree; `npm ci` installed the lockfile dependencies. Its postinstall warned that the checked-in `music-metadata` patch targets 11.13.0 while the lockfile resolved 11.15.0, though the patch applied successfully; npm also reported 3 high severity audit findings. No dependency files changed.
- First test run found `describe` was not imported from `node:test`; added the explicit import.
- First trigger rehearsal failed because deleting member rows before group rows removed the lookup needed by the second trigger statement. Reordered the trigger to preserve the deleted album's member row until group metadata removal, then clean the final row. Rerun passes.
- After extracting the pagination projection helper, the first web typecheck found two array types missing the helper's generic album parameter; corrected both annotations.
- Using `worker/wrangler.toml.example` as a Wrangler config was not recognized by Wrangler (it reported config type `none` and could not find the DB); this was local-only and caused no DB query. Added a dedicated minimal `.toml` fixture under `/test`; local migration then ran successfully.
- Removed the first implementation's candidate-specific SQL data seed after review; migration 0042 now contains only generic schema/index/cleanup logic. The test data was moved into local-only fixtures with synthetic IDs.
