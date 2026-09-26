# Pending upload album identity audit

- [x] Establish an isolated branch and inspect the existing pending-upload repair conventions.
- [x] Capture production-primary D1 and R2 evidence for the four requested physical directories.
- [x] Classify each directory as a complete album, a multi-disc/edition set, or unresolved.
- [x] Generate a snapshot-guarded D1 candidate only for a safe complete cohort, preserving all objects.
- [x] Refresh all 28 source rows and the pending cache from primary using SELECT-only D1 queries.
- [x] Generate per-field exact guards from the captured JSON snapshot, including the CUE object's physical key.
- [x] Rehearse success, stale-source rejection, and a marker-induced late failure with local Wrangler D1.
- [x] Repeat the SELECT-only primary preflight after the rehearsals.
- [x] Commit the isolated audit artifacts.
