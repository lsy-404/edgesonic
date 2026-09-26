# Pending library follow-up

- [x] Capture and compare both 13-track WAV editions, verifying distinct PCM for every pair.
- [x] Capture all 26 exact production rows and build a field-by-field `VALUES` guard across masters, instances, objects, and entries.
- [x] Limit master updates to the 26 snapshot IDs; guard edition counts, pending aggregates, stale references, and final album/group integrity.
- [x] Run real local Wrangler success, stale-snapshot, and forced late-invariant scenarios.
- [x] Run a production primary SELECT-only preflight; confirm zero rows written.
- [x] Commit only this task directory on the existing task branch.
