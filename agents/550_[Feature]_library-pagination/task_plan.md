# Library pagination implementation

## Goal
Replace Library infinite-scroll and fixed fetch limits with selectable 20, 50, 100, 200, or 500 item pages and page navigation across normal artists/albums/songs, starred lists, and library search results. Preserve embedded detail routes and locate-current behavior.

## Scope
- `web/src/views/Library.vue`
- `web/src/lib/librarySearch.ts` and focused helper tests as needed
- Locale keys limited to Library pagination labels; navigation/client locale edits are owned elsewhere.
- Tests live under repository-root `/test`.

## Decisions
- Use the API's `count`/`offset` paging for search and regular lists; do not pull the whole song library just to render pages.
- Slice only fully fetched starred lists and artists. Fetch requested server pages on demand, caching loaded rows when safe.
- Filter instrumentals while walking song results so each visible page fills correctly and end detection reflects filtered results.
- Preserve play-queue indices against the visible result list.

## Validation
Run focused tests and frontend typecheck if dependencies are available.
