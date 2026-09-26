# Task plan

- [x] Select the Find-Zero multi-disc cohort and define a D1-only boundary.
- [x] Capture fresh primary state for masters, instances, storage objects, source tree, album references, and track/disc assignments.
- [x] Decode and compare all fourteen CD1 WAV and FLAC pairs; retain both editions because all matched PCM differs.
- [x] Generate CTE-based fail-fast apply and rollback statements with exact source identity snapshots and no explicit transaction syntax.
- [x] Rebuild fixtures and pass actual Wrangler local D1 apply, rollback, stale-scope refusal, and late-reference rollback refusal.
- [x] Rerun the read-only primary preflight; all 25 exact rows match and no production writes occurred.
- [x] Review and commit this repair on the existing task branch.

## Release year follow-up

- [x] Recheck the existing album year from the production primary.
- [x] Leave the new WAV album year NULL because no source evidence supports a year.
- [x] Update local fixture and assert NULL through real Wrangler D1 execution.
- [x] Rerun successful apply/rollback, stale-state refusal, and late-reference rollback refusal.
- [x] Refresh the primary read-only scope preflight and verify no writes.
- [x] Commit the follow-up on this task branch.
