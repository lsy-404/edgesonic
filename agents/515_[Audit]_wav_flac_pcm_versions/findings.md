# Findings

## Scope and safety

Audit only. No production D1/R2 mutation or R2 deletion was performed. Production queries were served by primary and report `changed_db=false`, `rows_written=0`. R2 objects were retrieved read-only with Wrangler `r2 object get --remote`.

## Full PCM comparisons

PCM receipts are recorded in `north_star_pcm_receipt.json` and `star_pcm_receipt.json`. Each object pair was decoded using ffmpeg to signed 32-bit little-endian PCM; source streams were 44.1 kHz stereo 16-bit. SHA-256 and decoded byte counts were compared.

### 南北极星 Vol.1 — retain both formats

- Album `al-fb9bf31d39`: 8 WAV and 8 FLAC rows, same album, corresponding track order. Primary inventory showed no missing instances/objects; all 16 exact R2 objects were retrieved.
- Result: 0/8 exact PCM matches. Tracks 1–7 have equal decoded lengths but different PCM SHA-256. Track 8 differs in both hash and length (WAV decodes to 588 more stereo samples).
- WAV titles include differing instrumental naming, but this does not change the audio conclusion. Both versions must remain available. Since they already share one album ID, no display-group change is needed for this pair.
- Z cache has all 8 WAV files under `Z:\OneDrive - 510V\Archive\music\南北极星 Vol.1`; cache WAV byte sizes differ from production objects, so cache files were not used for PCM claims. The local download FLAC files match the production object sizes; its first FLAC was independently byte-identical to the production R2 GET (MD5 `72b03479f37d95ded797a0d36a95bb60`). PCM comparison used production GETs for both sides.
- Existing inventory reports a shared album cover, lyrics on WAV tracks 1–4 only, and zero album/song annotations, bookmarks, playlist links, or share refs. Queue entries are completed metadata work only. Keep these relations with the album.

### 星 — exact WAV/FLAC PCM duplicate; retain MP3

- Album `al-4a5d668099`: 7 WAV, 7 FLAC, and 7 MP3 rows. Fresh primary query returned 21 rows with exact instance/master/object links; `served_by_primary=true`, `changed_db=false`, `rows_written=0`. Full rows are in `fresh_primary_star_rows.json`.
- All 14 WAV/FLAC objects were successfully retrieved from production R2. Result: 7/7 WAV/FLAC pairs have identical decoded PCM SHA-256 and byte counts. Per-track PCM hashes, object keys, sizes, and stream details are in `star_pcm_receipt.json`.
- Keep the MP3 edition untouched; this task did not establish lossy MP3 PCM identity.
- Both lossless encodings use the same album cover `covers/al-4a5d668099`; master covers and master lyrics are null. Fresh primary counts are zero for annotations, bookmarks, playlists, and share references on these masters. Each WAV/FLAC/MP3 instance has one completed metadata queue row and no active work.
- Metadata reconciliation was verified from fresh primary plus exact R2 GETs. All WAV/FLAC titles, album names, album artists, dates, and track numbers agree (WAV `n/7` vs FLAC `TRACKNUMBER=n` + `TRACKTOTAL=7`). FLACs have genre `Miscellaneous` while WAVs have `Vocaloid`; FLAC `composer` is track-specific and missing from WAV. WAV performer strings already include the FLAC's generic 洛天依 credit on alternate-performer tracks; D1 still needs an explicit secondary 洛天依 `song_artists` row on tracks 1, 3, 4, 5, and 6 (tracks 2 and 7 already have it). WAV embedded art and album art have SHA-256 `8722290db25c0266486b01091b8c46009a46d3405c9f7f279aa49c64e8e017c6`; the FLAC's distinct embedded art is `120c4414718682f0efaa0fc32204e84edb330379a501657a524817d55e289487`. No embedded or D1 lyrics exist. Candidate WAVs append the FLAC genre, composer, extra embedded artwork, and Vorbis tracktotal/disctotal values while retaining WAV tags and existing artwork; 7/7 decoded PCM SHA-256 values remain identical, local R2 put/get bytes match, and all 7 candidate files are locally verified. This also keeps the shared album cover unchanged.

A guarded WAV-only D1 candidate is prepared at `star_wav_only_candidate.sql`, SHA-256 `e770614ddd2e329c77cc09b287d876f7eacb1f047f393de1726643be234af5ca`. It inserts new immutable tagged-WAV storage object rows, repoints only the existing WAV instances and their source-tree entries, adds the five secondary 洛天依 song_artist links, deletes only the seven FLAC masters/instances, and sets the album to 14 masters (7 WAV + 7 MP3), 0 duration, 393027398 bytes. It leaves the seven old WAV and seven old FLAC object rows/R2 keys, FLAC tree entries (unlinked), album/cover identity, all MP3 masters/instances, and completed metadata queue history intact. All current row references to FLAC masters are zero. The local Wrangler D1 success rehearsal passed; stale ETag and forced late-failure batches both failed and rolled back with unchanged snapshots. See `star_wrangler_local_rehearsal.json`.

Fresh primary preflight against the exact candidate SHA returned `guard_failed=0`, `served_by_primary=true`, `changed_db=false`, and `rows_written=0` (`star_wav_only_preflight_receipt.json`). The seven new D1 IDs and physical keys are absent from primary; all seven production R2 keys were independently GET-probed and are absent. This is conditional GO for parent-controlled object staging and D1 execution only: upload all seven local WAVs first, GET each staged object and verify the receipt SHA/MD5/size; then rerun the exact fresh primary preflight immediately before the D1 batch. Any mismatch is a stop. The read-only postflight is `star_wav_only_postflight.sql`. No production D1 or R2 mutation was performed by this audit agent.

## Initial production inventory and next candidates

Existing primary snapshots in this directory identify WAV/FLAC pairs in `Sing Sing Sing` (`al-87dd5c037a`, 7+7), `现实逃避Project` (`al-2970d648d9`, 8+8), `百变绫绫` (`al-99fca0b372`, 9+9), `梦的七次方` (`al-9be06043b0`, 7+7), and `流星空间站Ⅱ聆星者` (`al-e32d0f45ff`, 6+6). These snapshots are discovery evidence, not PCM verdicts. `百变绫绫(Ins)` is a separate album and must not be included. No indexed X3 album/song/path match was found in the initial query.

Safest next move: prepare a separately reviewed metadata-preserving WAV-retirement candidate for `星`; keep its MP3 edition. Before any future write, re-read all exact IDs, unique tag fields, annotations/bookmarks/playlists/shares and active queue states from primary. For remaining titles, fetch and compare production pairs before proposing any consolidation.

## Decision

- `南北极星 Vol.1`: NO-GO for FLAC retirement; 8/8 decoded PCM pairs differ. Preserve both versions.
- `星`: PCM duplicate confirmed for 7/7 WAV/FLAC pairs; a tag-preserving WAV-only D1 candidate is conditionally ready after parent uploads and reads back the seven new immutable WAV objects, then reruns fresh primary preflight. Keep MP3.
- The audit agent made no production writes or deletions; the parent later executed the separately reviewed D1 candidate, retaining all R2 objects.

## Remaining five PCM results

| Album | Exact PCM | Recommended handling |
|---|---:|---|
| 百变绫绫 (`al-99fca0b372`) | 0/9 | Preserve WAV and FLAC; all normalized PCM comparisons differ, including mixed-bit-depth cross-checks. Exclude `百变绫绫(Ins)`. |
| 现实逃避Project (`al-2970d648d9`) | 8/8 | Retain WAV; preserve FLAC-only secondary artist credits on WAV masters before retiring FLAC masters. |
| Sing Sing Sing (`al-87dd5c037a`) | 0/7 | Preserve both versions; all decoded PCM hashes differ. |
| 梦的七次方 (`al-9be06043b0`) | 0/7 | Preserve both versions; all decoded PCM hashes differ. |
| 流星空间站Ⅱ聆星者 (`al-e32d0f45ff`) | 0/6 | Preserve both versions; all decoded PCM hashes differ. |

The complete per-track object references, hashes, and decode facts are in each `*_pcm_receipt.json`. 南北极星 Vol.1 was 0/8; 星 was 7/7 exact, with tag/reference preservation still requiring separate review. Across all seven groups, “different” means both files decoded successfully and normalized PCM bytes compared unequal; none of these pair verdicts is an unavailable or failed decode.

### 现实逃避Project tag and reference conservation

- All 16 exact object pairs were fetched from production R2 and the 8 WAV/FLAC pairs are 8/8 exact PCM at 44.1 kHz stereo, signed 16-bit; s32 and f32 normalized SHA-256 and decoded byte counts match per track.
- WAV ID3 and FLAC Vorbis comments carry the same album, title, artist text, album artist, genre, composer, date, track, and disc values. WAV `TRCK=n/01` corresponds to FLAC `TRACKNUMBER=n` / `TRACKTOTAL=01`. Both sides have one embedded JPEG cover per track; all 16 copies share SHA-256 `1ccebc0414c84129033fd909cc3e18b71f40dae4bc7d7eeae69ca7d2f72c3bd7`. No embedded lyrics frame/comment was present, matching empty D1 lyrics fields. A local WAV rewrite or R2 staging was not needed.
- Fresh primary found 3 secondary contributor rows unique to FLAC masters: 乐正绫 on track 1; 言和 on tracks 3 and 8. Candidate adds those exact `song_artists` rows to the corresponding WAV master IDs before retiring FLAC masters. Main artist, album artist, title, lyrics, and cover relationships otherwise match.
- Fresh primary preflight returned `guard_failed=0`, `served_by_primary=true`, `changed_db=false`, `rows_written=0`. Candidate SHA-256 was `e3bbdeed41960fce749bd191230c4f6097beccdbb966cc876357ce6bf4f57150`.
- Wrangler 4.128.0 local D1 `--file` rehearsal passed success. A changed old object ETag triggered the initial fail-closed sentinel; a forced late CHECK after the entire candidate also failed. Both failure batches left local state unchanged. Receipt: `reality_escape_project_wrangler_rehearsal.json`.
- Parent executed the candidate. Fresh primary postflight returned `served_by_primary=true`, `changed_db=false`, `rows_written=0`: album stats 8 tracks / 2,126 sec / 379,557,136 bytes; 8 WAV instances and 0 FLAC instances; all 8 retired FLAC object rows remained; the 8 source-tree file entries were later removed by the separate guarded cleanup after scan re-import behavior was identified; all 3 secondary artist credits remain on WAV masters; 8 completed FLAC metadata queue records remain as history. Album/song annotations, bookmarks, playlist/share refs, transcode refs, active stream and queue refs, clone refs, and lyrics documents are all 0. Postflight query is `reality_escape_project_postflight.sql`.

## 2024/2025 pending WAV PCM comparisons

Fresh primary exact-ID inventory and read-only R2 GETs are recorded in `pending_wav_flac_pcm_receipt.json` (28 objects, every fetched object's byte count and MD5 matched primary D1). All files decoded successfully to 44.1 kHz stereo s32le.

- 2024 compilation: 13/13 WAV-vs-FLAC pairs differ in full PCM SHA. Each WAV starts with a PCM byte-for-byte prefix equal to the entire corresponding FLAC and adds exactly 705,600 s32le bytes (2.000 seconds). Four WAV tails are all-zero; the others contain nonzero samples. Keep both versions for all 13 pairs.
- 2025 track 14: pending WAV `ONE SEIF` vs release FLAC `ONE SELF` differs in full PCM; the common prefix is identical and WAV adds 4,704 bytes (588 stereo sample frames, about 13.33 ms), nonzero. Keep both. Titles alone were not used to infer identity.
- All reads were primary / `changed_db=false` / `rows_written=0`; no production writes were made.

### Scan re-import containment

The scanner's `newObjectRegistrations` path can recreate retired masters from a stable R2 object when a matching `storage_entries` file row remains with `instance_id IS NULL`. Therefore a WAV-over-FLAC retirement must remove the exact retired FLAC file tree entries while retaining the `storage_objects` and R2 objects as recovery data.

- Reality Escape Project: parent applied the reviewed cleanup candidate for all 8 exact FLAC tree entries. A fresh primary read verified 0/8 exact entries remain, 8/8 FLAC object rows remain, and the album still has 8 WAV / 0 FLAC instances. Read metadata: primary, `changed_db=false`, `rows_written=0`.
- Star: candidate SHA `e9b81b45f0c331d4fd5d547f78007cb4087ca01ce692be25a2932058aab96ec9` now deletes the 7 exact FLAC `storage_entries` in the same fail-closed batch as master retirement. Seven FLAC objects and R2 keys remain. Recovery is captured in `star_flac_tree_recovery_snapshot.json` and `star_flac_tree_recovery.sql`. Primary verified 0 child entries and 0 `companion_of` references for the seven exact FLAC entry IDs; both zero-reference conditions are included as fail-closed guards. Local success/stale/late rehearsal passed; fresh primary preflight returned zero guard failures and zero writes. Do not run D1 candidate until reviewed; only parent executes production writes.

### Star WAV-only production result

Parent applied the final guarded candidate (`e9b81b45f0c331d4fd5d547f78007cb4087ca01ce692be25a2932058aab96ec9`), with Wrangler exit 0 and 114 rows written. Independent primary postflight verified the album has 14 masters: 7 WAV, 7 MP3, and no FLAC instances. All 7 newly tagged WAV objects are registered; all old WAV and FLAC object rows remain; the 7 retired FLAC tree entries are absent; and all 7 WAV source entries point to their staged objects. Five artist relations are restored, 21 completed queue records remain as history, and no active jobs or checked user references remain. Each staged-object size/ETag guard passed. The postflight was primary, `changed_db=false`, `rows_written=0`; see `star_wav_only_production_postflight.json`. No R2 objects were deleted.
