# Findings

## Scope

The prior classification identifies 243 moved masters in 25 safe album groups. Every included filename has one unique numeric index, while `track` and `disc` remain null. The proposed operation is D1-only and never changes R2 objects, instances, or album membership.

## Candidate construction

The candidate accepts only names beginning with an optional `Track` prefix, leading zeroes, then a one or two digit index followed by whitespace, period, underscore, or hyphen. A target album is included only when every reviewed moved member matches that form and no index repeats. This reproduces the reviewed scope of 243 masters in 25 albums. The snapshot is stored in `artifacts/snapshot_candidate.json`.

`apply_guarded.sql` has no manual transaction statements. Its update runs only when every expected master remains in its expected album with null `track` and `disc`, and its exact instance, object, file entry, source, parent, path, and filename all match the reviewed snapshot. A rename, reparent, source/object change, stale metadata value, or moved row causes zero updates across the whole candidate. `rollback_guarded.sql` has the symmetric all-row guard and resets only the expected assigned values.

Each included album has exactly one reviewed source parent. Every filename index is unique inside its album, so each target is a single-disc source set and has no reused index across discs. The complete parent and index evidence is in `artifacts/source_layout_summary.json`.

## Local rehearsal

- Success: all 243 rows received the expected index and disc 1; rollback restored all 243 null pairs.
- Stale row: one preexisting track/disc value prevented every update.
- Late rollback: one changed assigned track prevented every rollback update.

The results are in `artifacts/local_rehearsal.json`.

## Fresh primary D1 preflight

Twenty-five read-only D1 queries returned 243 rows from the primary. Every actual master ID and album ID matched the snapshot, every source-entry guard matched, and all 243 rows still had null `track` and `disc`. The primary receipt summary and exact returned rows are retained in `artifacts/primary_preflight_summary.json` and `artifacts/primary_preflight_rows.json`. No production mutation was issued.

## Wrangler local file validation

The candidate and rollback files both executed successfully through `wrangler d1 execute --local --file` against an isolated minimal local D1 schema. The SQL contains no manual `BEGIN` or `COMMIT` statement.

## Production postflight

After the approved production apply reported 243 written rows on the primary, 25 read-only D1 queries verified every expected master. All 243 have the expected album, filename-derived track, and `disc=1`; every instance, storage object, file entry, source, parent, path, and display name still matches. The 25 album summaries contain no duplicate track values or other anomalies. The receipt is `artifacts/postflight_execution_receipt.json` with per-row and per-album results beside it. This audit did not execute apply or rollback.
