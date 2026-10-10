# Findings

- The endpoint previously awaited all distinct R2 deletes before any D1 cleanup. A later failure therefore returned 502 while successful earlier object deletions left dangling entries, instances, object metadata, and master/stat rows.
- `storage_entries.parent_id` cascades on deletion. To preserve a retryable folder after partial failure, successful file entries are removed immediately and folder entries are removed deepest-first only after all object attempts succeed.
- Shared R2 objects remain protected by the existing preflight: every object entry and every referencing instance must be selected and deletable before R2 deletion. The follow-up object-row delete also checks that no entries or instances still reference it.
- Deletable instances are removed only after their last entry is cleared; orphan masters and their unused album/artist rows are cleaned after each completed group.
- Entries sharing one object are grouped by object ID and cleaned together after a single physical delete, avoiding order-dependent partial alias cleanup.
- The focused second-delete-failure regression verifies partial response, first-object entry/instance/object/master cleanup, retryable remaining nested folder and file rows, and successful retry. A separate case verifies same-object aliases are deleted once.
- Initial test attempts found no installed workspace dependencies. `pnpm install --frozen-lockfile` completed without changing the lockfile; both focused test files and Worker typecheck then passed.
