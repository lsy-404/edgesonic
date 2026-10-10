# Findings

- `WorkMode.vue` already exposes an explicit lossless dispatch section and has `edgesonicPost` support for AbortSignal.
- The permission API provides `hasPerm("dispatch_work")`; retrieval eligibility must additionally require the selected `scrape` task.
- The retrieval API is paginated at 100 records and returns `enqueued`, `skipped`, `scanned`, and `nextCursor`; the page must continue until the cursor is null.
- Keep each successful response cursor before requesting another page so a later failed request can resume without repeating pages.
- Initial typecheck could not start because this worktree had no installed dependencies. An offline frozen install populated ignored `node_modules`; typecheck and build then passed.
- The retrieval pagination contract uses lexicographically increasing cursors. The client now rejects repeated/backward cursors and malformed pages, requires all counters and the terminal cursor, and bounds page counters to 0–100.
- Extracted the page loop so tests exercise terminal traversal, continuation after partial failure, backward-cursor rejection, malformed responses, and abort before another request.
