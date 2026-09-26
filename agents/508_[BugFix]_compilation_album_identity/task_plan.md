# Task plan

1. Trace album identity in manual metadata apply, legacy tag reads, and explicit tag edits.
2. Reproduce same-folder compilation tracks splitting into separate albums when per-track album artist differs.
3. Implement a stable album identity for import using a source folder anchor while preserving intentionally separate editions.
4. Add focused tests under `/test`, run the relevant worker suite, and inspect the diff.
5. Deploy the verified fix, then audit already imported fragments for safe consolidation.
