# Findings

- [Pending upload with a terminal metadata task] -> The scheduled recovery query accepts only instances with no `wt-metadata-<instanceId>` row. A prior parser failure leaves a `failed` row, so the instance is excluded forever even though `enqueueUploadMetadata` can safely redispatch terminal rows with `upsert: true`.
- [Manual-upload generation marker] -> Marker-backed uploads already call `enqueueUploadMetadata`, which can renew a failed or canceled task. The gap affects legacy or markerless uploads.
- [Parser runtime] -> The browser executor returns parser errors through the normal work submission path; retry behavior is owned by the durable queue and recovery job.
- [Fix] -> A terminal upload task is eligible for one automatic retry. The retry counter lives in its durable payload, so a second parser failure stays terminal with its error diagnosis intact. Explicit user fallback remains able to renew a task.
- [Queue schema] -> `work_queue` has a JSON payload and no retry-generation column. Persisting the automatic-recovery counter in that payload avoids a schema migration while keeping the counter with the task it constrains.
- [Historical payload safety] -> The recovery predicate uses `CASE WHEN json_valid(payload)` before `json_extract`, so malformed task payloads receive their bounded retry without relying on `OR` evaluation order.
- [Worker typecheck] -> Could not start because this isolated worktree has no installed `@cloudflare/workers-types` workspace dependency. The focused runtime regression test completed successfully.
