# Task plan

- [x] Select the Find-Zero multi-disc cohort and define a D1-only boundary.
- [x] Capture fresh primary state for masters, instances, storage objects, source tree, album references, and track/disc assignments.
- [x] Decode and compare all fourteen CD1 WAV/FLAC pairs; retain both editions because every matched PCM pair differs.
- [x] Generate CTE-based fail-fast apply and rollback statements with exact source identity snapshots.
- [x] Pass real Wrangler local D1 apply, rollback, stale-scope refusal, and late-reference rollback refusal.
- [x] Confirm the WAV album year remains NULL, matching the existing album's unknown year.
- [x] Verify the existing FLAC cache and source sums from the primary: 14 masters/instances, 3173-second duration sums, and 411082170-byte instance size.
- [x] Guard the stale duration cache and source aggregates; recalculate pending, WAV, and FLAC aggregates.
- [x] Verify the rebuilt totals through a fixture containing the exact primary-derived FLAC master/instance rows.
- [x] Refresh the production primary read-only preflight; all source/cache predicates match and no writes occurred.
- [x] Commit this follow-up on the existing task branch.
