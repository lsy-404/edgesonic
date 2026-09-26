# Production receip

The repository operator executed the A-edition candidate with Wrangler against production. Wrangler exited successfully after five queries and reported 14 rows written. A separate primary postflight verified:

- Album `al-86f72c214f`: 8 tracks, duration 1,540 seconds, size 271,656,352 bytes.
- Pending cache: 549 tracks, duration 122,071 seconds, size 21,265,357,877 bytes; cached values agree with live aggregates.
- All eight WAV source instances, storage entries, and physical objects remain intact; tracks 1–8 are unique.

The two pre-existing anchor masters, track 3 `系统万象` and track 4 `致邀请老用户`, still have `disc=NULL`. The six newly assigned masters have `disc=1`. A guarded local-only correction is being prepared to set the two anchors to disc 1; it has not been run against production.

Primary read-only follow-up also confirms the B folder still contains 16 pending WAV files, in numbered positions 1–16, and that no B album or A/B display group exists yet. The A edition (8 tracks, including two bonus tracks) and B edition (16 tracks, including Narrator/Mobile variants and a separate cover) should remain separate albums and later become members of one display group. Do not create an empty group before B has been archived.

## Production postflight receip

The repository operator reports successful production execution of the B edition and two-anchor repair. The B candidate applied with SQL SHA-256 `E649B9B6BD901478BA4B8FA56C52653B6DFF951F32BCF6B5FBE9B0C2F210F00F`; the A anchor candidate updated the two existing rows. Independent postflight reported A 8 / 1540 / 271656352, B 16 / 3230 / 569772704, pending 523 / 116804 / 20308060661, all caches matching live aggregates, complete source references, no missing objects, and display-group members A at order 0 and B at order 1. No source audio or storage object was changed.

## Q5 WAV alternate production postflight receipt

The repository operator executed `prepare_q5_wav_alternate.sql` against production. SQL SHA-256: `7AE478CFF7A336F9FB5D96FB2F11C690CBB0693F789E89F0DEEF9221C8E9CD52`. Wrangler exited 0, reported 11 queries and 20 rows written, served by primary.

An independent primary postflight reported:

- Existing FLAC album unchanged: 10 tracks / 2,691 seconds / 457,556,360 bytes.
- WAV alternate album: 1 track / 259 seconds / 45,619,436 bytes.
- Pending: 522 tracks / 116,545 seconds / 20,262,441,225 bytes.
- All three cached aggregates equal their live aggregates.
- Display group contains exactly the FLAC album at order 0 and WAV alternate at order 1.
- Existing FLAC master id 486 and the WAV master, instance, object, entry, path, and physical key remain intact; missing references = 0 and `tag_scanned=1`.
- No active related queue item and no guard marker remain. `quick_check` is `ok`; `foreign_key_check` returned no rows.
- The postflight was SELECT-only and reported zero rows written.

No production write was issued by this audit agent. The observed pending cache is one track lower than the pre-execution prediction because the candidate was executed by the repository operator.
