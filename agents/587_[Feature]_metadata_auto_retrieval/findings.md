# Findings

- The browser work pool is already the execution path for metadata retrieval; server changes should only enqueue bounded scrape tasks.
- Tag parsing readiness is `song_instances.tag_scanned = 1`; retrieval eligibility must independently use missing catalog fields.
- `work_queue` records are keyed by master ID and can carry durable review markers in `error_message` and candidate data in `result_json`.
- Automatic dispatch must preserve catalog/source snapshot validation and avoid resetting completed review tasks.
- Candidate executor contract: pending result status is `pending`, with reason `ambiguous` or `no-credible-match` and up to ten candidates; manually selected candidates use shared selectable-match validation without requiring a strong automatic anchor.
