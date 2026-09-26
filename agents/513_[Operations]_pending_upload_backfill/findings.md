# Findings

## Final candidate

- Safe-only manifest: 33 independent source-parent-codec groups / 310 masters. Every group has a unique target album ID derived from the runtime helper and a literal source-folder label. No title deduplication, R2 operation, sidecar update, or unrelated-row update is included.
- Final `manifest_safe.json` SHA-256: `1fafd3214b643a4ef27529adae3c524aca21a8aaba42b16a5f443e5f07a99c66`.
- Final `candidate_map_safe.json` SHA-256: `b60e703efafc69a4bd0b6f188c9435e49d9f46c3c5fda81643eccf86066975f5`.
- Manifest says 752 of the refreshed 1,062-master pending cohort are excluded from this operation; those include 601 held candidate masters plus 151 earlier no-entry/disc/bonus/quality-root exclusions. The live album catalog changed during the investigation, so do not use a static whole-library album count as a guard.
- Fresh production-primary read-only preflight: 33/33 PASS, 310/310 exact pending masters and storage links, zero target collisions, title/track conflicts, or unallowlisted sibling masters. Served by primary; `rows_written=0`. Timestamp in `preflight_summary_safe.json`.
- Local SQLite rehearsal: all 33 groups applied, early rollback restored all 310, late rollback preserved an external member and its cover/annotation/display-group reference, stale state failed closed. No production apply was run by this task.

## Guard change for D1

The initial apply/rollback files used `CREATE TEMP TABLE` as a temporary assertion mechanism. Cloudflare D1 rejected that DDL with `SQLITE_AUTH` before any production mutation. Primary verification after the failure showed 0 candidate rows moved and all 12 first-batch rows still pending.

The final generator uses an `INSERT INTO work_queue ... SELECT ... WHERE NOT (guard)` with deliberately invalid status `guard_failed`; `work_queue.status` has a CHECK constraint excluding that value. A passing guard inserts no row. A failed guard raises a constraint error before any album/master write. Per-master writes have a `changes()!=1` assertion; the final aggregate check requires two album rows updated and the expected target count/song_count/size. Rollback has an initial whole-group storage-link guard, per-master assertions, and a final pending/target membership check. The final manifest contains these regenerated statements.

## Identity exclusions and holds

Groups are held as a whole on any ambiguity. This includes the 13-track `忘川风华录·数风流` group because after removing filename track numbers its 13 titles match the existing `数风流` album in the same order. Name review also holds strong edit-distance/prefix/version collisions such as `Freesia` versus `Fressia`, `夜幻寻梦    夢ノ結唱`, `页间曲-星韵社`, the 夏浪 event variants, both `你的灵魂长出一支玫瑰` versions, `依路相随（二刷）不羁阁`, and `追光逐影`.

`similar_name_audit.json` compares all 111 original candidate group names to the primary album-name snapshot after NFKC/casefold/alphanumeric normalization. It records nearest strong prefix/edit-distance matches. Generic short labels were not treated as identity proof. `stripped_title_results` records primary read-only queries comparing candidate titles with leading track numbers removed against non-pending album tracks. Apart from the held 13-track sequence, two isolated exact title overlaps were found; these are not enough to infer same-release identity or to deduplicate audio.

## Metadata still missing

All final 310 masters have null `track` and `disc` snapshots. Of these, 257 titles have a numeric filename-style prefix; 243 masters across 25 groups have a numeric prefix on every track with unique indices. The remaining 67 masters are in mixed/unprefixed groups. A later guarded metadata operation can consider only the 243 fully numbered masters after checking exact per-group index sets and the single-disc assumption. This backfill deliberately preserves title strings and does not set track/disc values. Twelve of the final 310 titles have a literal `Track ##` prefix; their descriptive suffix is present, but the prefix remains in the stored title.

## Sidecars and references

The candidate SQL changes only `song_masters.album_id` and recomputes `albums.song_count`, `albums.size`, and `updated_at`. It leaves every master, instance, object, storage entry, queue row, lyric row, playlist/annotation reference, and R2 object in place. It does not associate cover/CUE/LRC/image storage entries with a new album or track. The read-only parent-level inventory records six CUE and one lyric entry under parents containing safe candidates; because parents can contain multiple candidate folders, these counts are not assigned to a particular release. `追光逐影` remains held pending an explicit cover/lyric/CUE association plan.

## Execution notes for the parent

1. Verify the manifest SHA and `candidate_map_safe.json` SHA above before executing anything; `manifest_safe.sha256` records the current manifest digest. Do not regenerate the manifest or any `batches_safe` SQL while applying.
2. Each manifest group is one independently guarded D1 file. Apply one `batches_safe/apply/<batch_id>.sql` at a time; stop on any Wrangler error. The first batch failure proved the old temp-table files are obsolete; use only files listed in the final manifest.
3. After each successful apply, run the matching `batches_safe/postflight/<batch_id>.sql` as SELECT-only and require the full expected membership, stored song count, and calculated size. Save the result as an execution receipt with batch ID, manifest SHA, apply-file SHA, result, and timestamp. Do not blindly retry: a repeated apply should fail its pending-state guard; inspect primary first.
4. If a batch needs reversal, use only the matching `batches_safe/rollback/<batch_id>.sql`; it restores only exact candidate masters and deletes the empty target album only if no outside master, display-group member, or annotation references it. Then run that batch's postflight and check both expected sides.
5. After all 33 batches, run `postflight_total_safe.sql` and `postflight_excluded_safe.sql`. Require 310 expected candidates moved, 310 still-pending candidates reduced to zero, 33 target albums at expected sizes, and 752 excluded-snapshot rows still pending. Re-read primary before any later metadata or sidecar operation.

The final GO applies only to guarded album-ID assignment for these 310 masters. Track/disc metadata and sidecar association are separate follow-up operations.

## Production execution and independent postflight

The parent executed all 33 guarded files. The first invocation of batch 001 stopped at the obsolete temporary-table guard and made no change; the parent then executed the regenerated DML-guard manifest above. Batch 001 retry and batches 002–033 completed with exit code 0. No raw CLI logs are committed; the parent retained them under its local temporary log directory.

At 2026-09-26 10:41 UTC, this task independently queried production primary D1 using only SELECT statements, with `rows_written=0`, and confirmed:

- 310 expected candidates; 310 moved to their target IDs; 0 still pending.
- 33 target album rows; all 33 have expected `song_count` and calculated size.
- 752 excluded snapshot masters found; all 752 remain in `pending-uploads`.
- Every individual batch postflight passed. Compact per-batch receipts are in `batches_safe/postflight_receipts_<manifest prefix>/`; summary is `postflight_execution_receipt.json`.

This confirms catalog association only. The stored title values and null track/disc fields were preserved exactly. No sidecar/lyric/R2 data was rewritten.

## Approved safe groups

| Album folder label | Masters |
|---|---:|
| AI绫 | 10 |
| FM404 | 9 |
| OTOME | 9 |
| SE＞EN(Sya)SEVEN | 10 |
| Stay | 7 |
| Still With U | 13 |
| bilibili 乙巳蛇年拜年纪：跨越数千昼夜 | 16 |
| cop十周年纪念专辑 | 16 |
| sakuya薯片~THE NOCTURNE | 8 |
| 世界沉睡童话 | 5 |
| 人造树的幽灵 | 8 |
| 众虫皆歌 | 10 |
| 低语者 | 8 |
| 兰音.2024.《形神合一》 | 10 |
| 哈利波特·学院印象曲 | 10 |
| 四季有时 | 5 |
| 回声漫过荒原 | 10 |
| 如期归还 | 12 |
| 实力至上-奇怪雷子QGRay | 10 |
| 幽灵摄影 | 10 |
| 心语 | 10 |
| 忘川风华录·溯洄 | 10 |
| 旧未来ЯEMIXTION | 12 |
| 星座-扑克 | 12 |
| 春华秋拾 | 4 |
| 洛天依的构成 | 7 |
| 花と約束 | 5 |
| 衔风与愿 | 1 |
| 被那个夏天厌恶的我们 | 7 |
| 赏味期限 | 11 |
| 逆进化ЯEVOLUTION | 10 |
| 黑猫出现在白天-七点半 | 14 |
| 黑白 | 11 |

## R2 PCM verification for held version cohorts

At 2026-09-26, this task fetched the exact 44 immutable production R2 objects named in the primary D1 scope snapshots: 12 `Freesia/wav` WAV files and their 12 `Fressia` FLAC counterparts, plus 10 `页间曲-星韵社/wav` WAV files and their 10 existing `页间曲` FLAC counterparts. The R2 reads used `wrangler r2 object get --remote`; no R2 or D1 write was issued.

For each matched track, FFmpeg decoded audio stream 0 to `pcm_s32le`, then SHA-256 hashed the complete decoded byte stream. The raw-object SHA-256 and FFprobe container/stream/tag inventory are in `pcm_r2_comparison.json`. This is a strict whole-stream comparison: it includes every decoded sample and does not treat padding, silence, or matching titles as equality.

| Cohort | Pairs | Equal PCM | Distinct PCM | Classification |
|---|---:|---:|---:|---|
| Freesia WAV vs Fressia FLAC | 12 | 0 | 12 | Keep both editions |
| 页间曲-星韵社 WAV vs 页间曲 FLAC fragments | 10 | 0 | 10 | Keep both editions |

All 44 streams are stereo 44.1 kHz signed 16-bit audio, but each paired WAV/FLAC has a different complete PCM digest and decoded sample count. The WAV objects have little or no descriptive embedded metadata, while the FLAC counterparts carry album, artist, title, date, replay-gain, and, for Freesia, lyric data. Tags therefore reinforce that the FLAC catalog metadata can inform a separate metadata operation but cannot justify deleting or merging any WAV master.

The existing `Fressia` album and all nine existing `页间曲` fragment album rows are currently ungrouped in `album_display_group_members`. The pending WAV masters remain unmodified. The later guarded candidate below uses the Fressia album directly and consolidates the page FLAC fragments before it groups the resulting editions. No exact PCM pairs were found, so the conditional metadata-merge-and-keep-WAV path is not authorized for either cohort.

## Guarded version-group candidate

The current candidate is D1-only and has not been applied to production. It creates two WAV edition albums, groups `Freesia` with existing `Fressia`, and groups a new `页间曲` WAV edition with a consolidated existing FLAC `页间曲` album. The page FLAC inventory was freshly verified as 10 masters with unique track values 1 through 10: nine album rows hold those masters, with one row holding tracks 8 and 10. The candidate retains `al-7e5eae45c8` (track 1) as the canonical FLAC album, moves the other nine FLAC masters into it, then removes the eight empty, unreferenced fragment albums.

For each WAV master, the candidate keeps its ID, title, R2 object, instance, storage-entry tree, and master-specific credit rows. It copies only source-supported fields from the paired FLAC master: artist, album artist, genre, per-track cover, participants, lyrics, rich lyrics, track, and disc. The Freesia WAV album receives the existing Fressia album cover; the page edition receives no album cover because its verified source album has none. No audio, title, storage object, storage entry, or `song_artists` record is merged or deleted.

`version_group_apply.sql` guards all 22 pending WAV/master-instance-entry-object snapshots, source album cardinalities, unique page tracks, new album/group ID collisions, pre-existing display membership, and annotations on the eight fragment albums. It then asserts every individual move and aggregate update. `version_group_rollback.sql` restores the original WAV metadata and page fragment assignment. It removes only its four group memberships and deletes a created group or WAV album only when no external member, master, annotation, or reference remains.

Fresh production-primary SELECT preflight passed with `rows_written=0`: 22 pending WAV masters, 22 matched FLAC masters, 10 page FLAC tracks with 10 distinct numbers, zero target-ID collisions, zero existing display memberships, and zero fragment annotations. The source snapshots, candidate map, SQL digests, and primary receipt are in `version_group_primary_inventory.json`, `version_group_master_metadata.json`, `version_group_candidate.json`, `version_group_preflight_primary.json`, and the three `version_group_*.sql` files.

Local SQLite rehearsal passed: successful apply produced two target albums, two two-member display groups, a 10-track consolidated page FLAC album, and zero moved candidates left in pending; early rollback restored the full starting state; a title-stale candidate was rejected atomically; late rollback restored all 22 candidate masters and page fragments while preserving an externally added target master, annotation, and display-group member. The candidate remains a review-only proposal pending a new production preflight immediately before any execution.

The revised candidate labels the new editions `Freesia (WAV)` and `页间曲 (WAV)`, so the edition picker distinguishes them from their FLAC members. It sets their supported release years to 2022 and 2025. Freesia copies the evidenced `未知流派` genre and album cover; page has no evidenced album genre or cover and remains null for both. Its guard now snapshots all ten source album metadata rows, including name, sort name, year, genre, cover, counts, duration, size, and compilation. Aggregate updates recompute duration with song count and size.

Production-primary preflight also confirmed zero `clone_id_map` album mappings for the eight retiring page fragments. It found zero WAV `song_artists` rows and exactly one FLAC artist-credit row per paired track. The apply candidate guards those counts, copies the 22 source artist-credit rows to the distinct WAV masters, and the rollback removes only those copied rows. The revised local rehearsal retains the zero-to-22 WAV credit transition on apply and restores zero candidate credits on rollback.

## Production postflight receipt

After the guarded production apply, an independent primary SELECT query returned `rows_written=0` and confirmed both Freesia albums at 12 tracks, both page albums at 10 tracks, four expected display-group memberships, and zero remaining retired page fragment rows. All 22 WAV masters retained their exact title snapshots and original instance, storage-entry, and storage-object linkage; they have 22 copied artist-credit rows. `version_group_postflight_primary.json` contains the primary receipt.
