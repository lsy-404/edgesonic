# Metadata retrieval server workflow

- [x] Confirm queue and catalog schema, route conventions, and executor payload.
- [x] Extract retrieval route, selection, and apply logic into a focused feature module.
- [x] Add bounded cursor dispatch for available masters with missing metadata.
- [x] Add terminal restart with monotonic attempts and active/pending-apply protection.
- [x] Apply completed retrieval results under exact claim and source/catalog snapshot guards.
- [x] Add isolated D1-backed tests for restart, paging, staleness, application, and replay.
- [ ] Run final focused checks and commit scoped changes.
