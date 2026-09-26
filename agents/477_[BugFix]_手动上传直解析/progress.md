# Progress

- Confirmed requested worktree path and `codex/manual-upload-direct-flow` branch were unoccupied, then created the isolated worktree from deployed main.
- Read project audit guidance and traced current upload, metadata submit, authorization, worker queue, and cover/lyrics paths.
- Implemented browser-direct metadata submission with a 30-minute HMAC capability bound to account, instance, and current storage URI. Missing HMAC secret falls back to durable priority-5 queue dispatch.
- Direct metadata submit is restricted to an unscanned original instance; successful submission persists lyrics and an embedded cover and prevents sequential token replay. Existing audio overwrite requires `edit_tags` before bytes are replaced.
- Added cover-write retry routing for the case where tags were applied but R2 cover writing failed. Existing album covers are preserved; a retry is queued only when the album pointer is still empty.
- Added terminal-aware upload queue re-dispatch that leaves queued/claimed work intact, plus an independent hourly bounded recovery for aged `si-upload-*` tag0 placeholders with no metadata queue history. This covers closing the browser between byte upload and direct submit without repeatedly requeueing terminal failures.
- Added regression coverage for no duplicate direct-path task, API/failure fallback, upload-only authorization, user and object-scoped token validation, replay rejection, embedded lyrics/cover, cover retry, and protected overwrite.
- Verification passed: worker/web TypeScript checks; `submit_metadata.test.ts`, `upload_conflicts.test.ts`, and `work_submit_apply_metadata.test.ts`; `npm run build:web`; `git diff --check`.
- Hardened the cover CAS against ambiguous D1 responses by rereading the album pointer before deleting candidate objects. Changed the write result to explicit saved/preserved/invalid states and added race tests.
- Bound manual upload capabilities, pending markers, and fallback metadata payloads to a per-upload nonce. Successful cleanup matches the full marker payload; failed cover writes retain it for scheduled retry.
- Recovery now verifies or refreshes the deterministic task payload against the current URI and nonce. It does not consume markers when an old claimed task is still running or a queue row is stale.
- Added targeted tests for CAS winner/loser and ambiguous update outcomes, same-URI token invalidation, stale claimed fallback rejection, marker cleanup, and close-before-submit recovery.
- Final checks passed for four focused test files, all workspace typechecks, and the web production build. `git diff --check` is clean; build reports existing module externalization and chunk-size warnings.
- Reproduced a claimed task created before an overwrite and submitted afterward; current generation validation rejects its tags and leaves the new instance unscanned for recovery. Matching tasks apply and finalize their generation marker.
- Added a WebDAV authorization regression for a physical HEAD hit with no D1 row, plus checks that a registered overwrite persists its generation and resets tag_scanned before PUT and that failed PUT retains recovery state.
- Removed global agents project/task index files from the branch commit, retaining the audit records for this change.
- Follow-up verification passed: `work_submit_apply_metadata.test.ts`, `upload_conflicts.test.ts`, `upload_metadata_recovery.test.ts`, `submit_metadata.test.ts`, and `embedded_cover.test.ts`; all workspace typechecks; web build. No production writes or deployment commands were run.

- Serialized same-path overwrites and upload metadata applies through claimed marker leases with heartbeat renewal; scheduled recovery returns leases whose heartbeat expired to the pending state.
- Kept the generation lease through embedded-cover publication and added a marker-payload CAS so a stale candidate object is deleted instead of attached after lease loss.
- Added interleaving regressions for an old claimed task racing overwrite, two same-path uploads during PUT, stale lease recovery, and stale cover publication; direct metadata also now persists bit depth.
- Final focused verification passed after the lease changes: typecheck, eight internal test files, the web build, and diff checks. No production writes or deployment commands were run.

- R2 overwrite registration failures now preserve pre-existing physical bytes and retain the unscanned recovery marker; a post-PUT D1 failure regression passes.
- An independent review found that an orphan R2 path could change after target resolution. The path lease now rejects a changed entry identity, object, key, or instance before PUT.
- A post-PUT database failure now deletes only the fresh candidate when primary D1 reports zero instance and entry references to its object ID. Referenced candidates remain available to recovery, and the prior physical key is never selected for deletion.
- Added regressions for changed orphan paths, cleanup of unreferenced candidates for both orphan and existing-instance uploads, and retention when an instance already references the candidate. The focused upload conflict suite and worker typecheck pass.
