# Findings

## Production triage

The referenced classification evidence is in the independent worktree at [remaining_752_classification.json](C:/Users/User/.codex/worktrees/album-display-groups/lsy-404@edgesonic/agents/513_[Operations]_pending_upload_backfill/remaining_752_classification.json) and [remaining_752_classification.md](C:/Users/User/.codex/worktrees/album-display-groups/lsy-404@edgesonic/agents/513_[Operations]_pending_upload_backfill/remaining_752_classification.md). It is absent from this checkout. The surviving exclusion manifest and fresh primary query identify clear structural cohorts: `Distortion and Overdrive（2014）` has 12 WAV files in `disc.1` and 10 in `disc.2`; `Find-Zero` has vocal and instrumental CDs; `异色合鸣Chromatic Harmony` has A/B discs; and `夏日应时而至` has separate CD and vinyl-side versions. The latter three retain meaningful version or content distinctions and remain held.

## Candidate: Distortion and Overdrive（2014）

- Fresh primary D1 inspection found exactly 22 active, tag-scanned WAV instances in the two named folders, all still in `pending-uploads`, with null disc and track values.
- No existing album has a matching Distortion/Overdrive name and no non-pending master exists under the release root.
- The candidate assigns all 22 masters to `al-17e41d5b4f`, preserves every master, instance, stable object, and storage entry, and writes disc 1 tracks 1–12 plus disc 2 tracks 1–10. Stored titles retain their original global 01–22 prefixes.
- `apply_distortion_overdrive.sql` uses an invalid work-queue status as a pre-write failure guard. It validates the exact 22 pending masters, source/codec, active tag state, each expected disc folder, target absence, and absence of other active release-root masters.
- Local in-memory SQLite rehearsal applied the candidate (22 moved) and its early rollback (22 restored to pending).
- Fresh production-primary preflight: expected 22, pending rows with null metadata 22, exact active R2 storage links 22, target collision 0, and active release-root members 22. It was SELECT-only with `rows_written=0`.
- Candidate SHA-256: `8d6f44ba91848d3d24ca7caeb0b3fa64850e392835775e50ecfe86e5eccdbe9c`.

## Production execution receipt

The reviewed candidate was applied once through Wrangler with exit status 0 and 49 rows written. A subsequent primary-only read verified 12 unique track positions 1–12 on disc one and 10 unique positions 1–10 on disc two. The album has year 2014, 22 songs, duration 5,654 seconds, and size 997,418,054 bytes; both aggregates equal their independent recomputations. All 22 master, instance, entry, and stable-object links remain intact. The pending album then contains 694 masters.

## Remaining work

The local rehearsal script now covers all three cases. A stale source field fails the first guarded statement with the work-queue CHECK constraint before the update path runs. A late rollback adds an unrelated third-disc master plus cover, annotation, and display-group references after applying the candidate; rollback restores all 22 candidates and leaves the external master and all four album references intact. The local output is `{"stale_guard":"rejected atomically","late_rollback":"22 candidates restored; external member and references retained"}`.
## Final local rehearsal

An isolated `wrangler d1 execute --local --persist-to ... --file` fixture initialized the minimal `work_queue`, album, song, object, instance, entry, display-group, and annotation schema. The candidate applied successfully: disc one has 12 tracks and disc two has 10, while the target album holds year 2014, 22 tracks, 4,213 seconds, and 22,253 bytes. The stored duration and size equal their recomputed values.

Changing one reviewed source entry path caused the first guard to attempt the intentionally invalid `work_queue.status='guard_failed'`. The CHECK rejected the file before the target album or any candidate assignment was written: target albums 0, assigned masters 0, unchanged pending masters 22.

The rollback was also executed through Wrangler without manual transaction statements. After adding an unrelated album member, display-group membership, and album annotation, it restored all 22 candidate masters while retaining the unrelated member, album, display-group membership, and annotation.

The full entry ID, parent ID, path, instance ID, object ID, and master title snapshot is in `candidate_snapshot.json` and is enforced in the apply guard. Each candidate master must still belong to `pending-uploads`; this rejects any other-album assignment. The new target ID must not exist, so it cannot already carry display-group or annotation references. The release root count must remain 22 active file instances.

Disc two uses local track positions 1 through 10 because its filenames’ global sequence numbers are 13 through 22, and the source has a separate disc parent. The retained filename titles preserve that global sequence while `disc=2` gives the correct album structure.
