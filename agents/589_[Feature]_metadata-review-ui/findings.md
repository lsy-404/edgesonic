# Findings

- Work Mode already uses `hasPerm("dispatch_work")`, `edgesonicFetch`, and `edgesonicPost`; metadata dispatch is gated by permission plus selected `scrape` work type.
- The existing queue gauge counts all work lifecycle states and must be explicitly labeled as queue history/progress, separate from metadata field completeness.
- Pending-review actions must require an explicit click; stable unique matches may fill missing fields automatically, while ambiguous/no-match outcomes remain pending.
- Same-origin metadata scraping is available through `/tag/scrape`; UI candidate resolution must use the shared executor helper rather than introducing a proxy.
- Server and executor are being implemented concurrently; exact response shapes and permission gates are pending confirmation.

- Server owner confirmed completeness values count songs under a current field-presence policy across masters with a live original; review/queue values count scrape tasks independently of tag parsing.
- Server endpoints all require `dispatch_work`; the panel is additionally hidden unless the current account is admin.
- Executor owner confirmed candidate resolver output is a matched retrieval result preserving the selected source and song ID.

- A review payload `identity` includes source-path-derived hints and must never be displayed as existing catalog metadata. Show `snapshot` fields only.
- Keep the existing review list while a page request is in flight or fails. Defer poll/visibility refreshes during explicit row decisions, then refresh once after the last action settles.
- `counts.total` is the sum of the field-present and field-incomplete song counts under the server's agreed policy.

- [Vite runtime] A focused mounted SFC test was attempted with the repository's existing Vite Node harness; Vite Node repeatedly returned `ERR_CLOSED_SERVER` while resolving the component dependency graph. The component runtime check is therefore left to the parent browser validation, while the snapshot selection behavior is covered by a pure unit test.
