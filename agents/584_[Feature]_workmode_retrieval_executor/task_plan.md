# Plan: queued Work Mode metadata retrieval

- [x] Confirm the queue payload, management proxy shape, scraper adapters, and cancellation contract.
- [x] Implement conservative matching and provider-backed retrieval in the task worker.
- [x] Pass the authenticated scrape proxy URL and preserve the existing claim heartbeat identity.
- [x] Add focused tests under `/test` for selection, failure, cover bounds, runner handoff, and cancellation.
- [x] Run focused tests and typecheck; inspect and commit only scoped changes.
- [x] Add a loopback browser fixture for the real queued runner/proxy/provider flow, server dispatch/submit, and local SQLite catalog readback.
