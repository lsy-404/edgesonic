# Production receipt

The guarded candidate was applied through Wrangler successfully. The execution returned exit code 0, 13 queries, 36 rows written, and primary service; bookmark: `000039ea-00000054-000050f2-98270c55766a8cb1f418501f7d93b179`.

An independent primary postflight confirmed:

- Vocal edition: 10 masters, 2010 seconds, 354704714 bytes; cached values match actual rows.
- Accompaniment edition: 10 masters, 2037 seconds, 387524512 bytes; cached values match actual rows.
- Pending: 539 masters, 120034 seconds, 20877833365 bytes; cached values match actual rows.
- Display group contains exactly the vocal album at sort order 1 and accompaniment album at sort order 2.
- Accompaniment tracks are unique 1–10. Its 10 instances, objects, and entries are intact; all are present and tag-scanned. Paths and physical keys are intact. The vocal edition retains all 10 instances, objects, and entries.

This receipt records the production run reported by the coordinator and its independent primary postflight. No further production write was made for this receipt.
