# Findings

- Work Mode already uses `hasPerm("dispatch_work")`, `edgesonicFetch`, and `edgesonicPost`; metadata dispatch is gated by permission plus selected `scrape` work type.
- The existing queue gauge counts all work lifecycle states and must be explicitly labeled as queue history/progress, separate from metadata field completeness.
- Pending-review actions must require an explicit click; stable unique matches may fill missing fields automatically, while ambiguous/no-match outcomes remain pending.
- Same-origin metadata scraping is available through `/tag/scrape`; UI candidate resolution must use the shared executor helper rather than introducing a proxy.
- Server and executor are being implemented concurrently; exact response shapes and permission gates are pending confirmation.

- Server owner confirmed completeness values count songs under a current field-presence policy across masters with a live original; review/queue values count scrape tasks independently of tag parsing.
- Server endpoints all require `dispatch_work`; the panel is additionally hidden unless the current account is admin.
- Executor owner confirmed candidate resolver output is a matched retrieval result preserving the selected source and song ID.
