# Findings

## Scope

The prior classification identifies 243 moved masters in 25 safe album groups. Every included filename has one unique numeric index, while `track` and `disc` remain null. The proposed operation is D1-only and never changes R2 objects, instances, or album membership.

## Candidate construction

The candidate accepts only names beginning with an optional `Track` prefix, leading zeroes, then a one or two digit index followed by whitespace, period, underscore, or hyphen. A target album is included only when every reviewed moved member matches that form and no index repeats. This reproduces the reviewed scope of 243 masters in 25 albums. The snapshot is stored in `artifacts/snapshot_candidate.json`.

`apply_guarded.sql` is a single D1 transaction. Its update runs only when every expected master exists in its expected album and still has both `track` and `disc` null. A stale or moved row causes zero updates across the whole candidate. `rollback_guarded.sql` has the symmetric all-row guard and resets only the expected assigned values.

## Local rehearsal

- Success: all 243 rows received the expected index and disc 1; rollback restored all 243 null pairs.
- Stale row: one preexisting track/disc value prevented every update.
- Late rollback: one changed assigned track prevented every rollback update.

The results are in `artifacts/local_rehearsal.json`.

## Fresh primary D1 preflight

Six read-only D1 queries returned 243 rows from the primary. Every actual master ID and album ID matched the snapshot, and all 243 rows still had null `track` and `disc`. The primary receipt summary and exact returned rows are retained in `artifacts/primary_preflight_summary.json` and `artifacts/primary_preflight_rows.json`. No production mutation was issued.
