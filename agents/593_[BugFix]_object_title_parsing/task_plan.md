# Plan

- [x] Trace logical and physical path fields through upload, reparse, apply, and Subsonic reads.
- [x] Fix placeholder-only filename recovery in the shared helper without touching album or artist identity.
- [x] Pass a uniquely resolved `storage_entries.path` to metadata application and Subsonic display mapping.
- [x] Add regressions for hash placeholders, legitimate Objective titles, known metadata, empty reparse results, and physical object keys.
- [x] Run targeted regression scripts and Worker typecheck; inspect scoped diff.
- [x] Commit only implementation, tests, and this task's audit files.
