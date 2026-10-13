# Progress

- Audited upload, direct upload metadata submission, queued apply, tag reparse, and Subsonic queries. Confirmed original entry names are separate from R2 physical object keys.
- Added explicit logical-path recovery while retaining the physical-path guard and exact placeholder recognition.
- Routed unique logical paths through shared metadata apply, empty-tag reparse, song response mapping, and album display mapping. Direct upload metadata submission only accepts filename-only completion when the logical path provides a readable filename.
- Restricted tag-read filename fallback to recoverable placeholder titles or pending uploads with readable paths. Filename-only reads use the shared apply helper to preserve existing artist and album identity. Empty unsupported parses without a logical path remain untagged and unchanged.
- Narrowed metadata retrieval's `obj` identity detection to exact placeholders/current 16-digit generated ids.
- Rebased the branch onto `origin/main` at `821b1cd8`, resolved the task-index conflict by preserving upstream 590/591 and assigning this task 593, and renamed the audit directory.
- Validation: `pnpm --dir worker run typecheck` passed. Five targeted suites passed: object name recovery, legacy charset recovery, clone original path, upload metadata submission, and album artist round trip. `git diff --check` passed.
- The worktree uses a `node_modules` junction to the main checkout per task instruction; no source media was read.
