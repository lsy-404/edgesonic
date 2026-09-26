# Task plan

- [x] Map metadata relink writes and every reference that can be vacated.
- [x] Replace global album/artist sweeps with candidate-scoped cleanup and add only the index needed for bounded reference checks.
- [x] Add tests for removed stale rows and preservation of unrelated or still-referenced rows.
- [x] Run focused regression tests and worker typecheck.
- [ ] Record final findings and verify the branch diff contains only this task.
