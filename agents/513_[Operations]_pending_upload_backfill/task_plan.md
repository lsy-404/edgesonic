# Task plan

- [x] Load agent-mode and verify the assigned managed worktree/branch without touching the primary checkout.
- [x] Query production primary D1 read-only to refresh the exact pending cohort and test conservative eligibility guards.
- [x] Build the bounded candidate map and SQL preflight/apply/rollback artifacts without executing any production mutation.
- [x] Seed a disposable local SQLite fixture from the candidate map and rehearse successful apply plus early/late rollback.
- [x] Record exact counts, excluded reasons, candidate digest, risks, and GO/NO-GO recommendation.
