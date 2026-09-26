# Task plan

- [x] Trace album identity in manual metadata apply, legacy tag reads, and explicit tag edits.
- [x] Reproduce same-folder compilation tracks splitting into separate albums when per-track album artist differs.
- [x] Implement a stable album identity for import using a source folder anchor while preserving intentionally separate editions.
- [x] Add focused tests under `/test`, run the relevant worker suite, and inspect the diff.
- [x] Verify that a second metadata scan retains the source-folder album identity and track credits.
- [ ] Deploy the verified fix, then audit already imported fragments for safe consolidation.
