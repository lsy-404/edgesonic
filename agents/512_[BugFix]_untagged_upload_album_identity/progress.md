# Progress

- Confirmed root cause by read-only primary D1 queries and source-code trace. No production data changed in this task.
- Added source-path album-name recovery to the import metadata and legacy tag-read paths. Focused SQLite test covers technical-only metadata, format/disc folder handling, repeated scan stability, separate codec/folder identity, and physical metadata retention.
- Existing metadata work-submit integration test and worker typecheck pass. The first focused test run failed only because its minimal SQLite fixture lacked a `sample_rate` column; narrowed the assertion to its existing duration field and reran successfully.
- Expanded the path parser for real quality-folder labels found in the primary inventory, and covered an untagged legacy read where `parseTags` returns `null`. The focused round-trip suite and Worker typecheck pass after these changes.
- Independent reviewer gave GO for the new-upload runtime fix. Historical pending rows are a separate guarded data operation; 50 tracks under three releases have distinct physical quality-folder identities and remain separate editions until display grouping is audited.
- Fast-forward merged commit `7a96d3d` into local and remote `main` after a fresh protection/rules check. `npm run deploy` succeeded with Worker version `42addccf-dad3-43b9-adb5-fb2dd4f35198`. Live version endpoint returns `1.4.0-dev.7a96d3d`; live login configuration still reports `ssoMode=required`, provider `Voidcarve Access`, available true, and authentication unblocked.
