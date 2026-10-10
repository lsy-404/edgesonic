# Plan: Work Mode metadata review and automatic retrieval

- [x] Confirm server and executor request/response contracts and permission checks.
- [x] Add a small typed web helper for auto state, completeness/status paging, and review actions.
- [x] Add an admin and dispatch-permission gated Work Mode panel for opt-in automatic retrieval and pending decisions.
- [x] Keep historical work queue progress distinct from metadata completeness and pending review counts.
- [x] Localize all new UI text in English and Simplified Chinese.
- [x] Add focused helper tests under `/test` for response validation, paging, and review payloads.
- [x] Run focused tests, web typecheck/build, and scoped diff hygiene review.
- [x] Commit only this UI, helper, locale, tests, and audit scope.
