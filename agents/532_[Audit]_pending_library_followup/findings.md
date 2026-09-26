# Findings

Production D1 and R2 are read-only. A same-title file is not treated as the same recording until exact lossless PCM evidence establishes that relationship.

`洛天依共鸣合集` contains pending MP3 files alongside already grouped WAV editions, so it remains audit-only. The rose release has separate 13-track 人声 and 言和 WAV editions. The 人声 folder is complete, active, scanned, sequential by filename, and entirely pending; the guarded candidate creates a standalone 人声 edition without touching the 言和 edition or merging PCM.

The final primary preflight found 13 masters, instances, and objects; every instance is an active scanned WAV and no candidate track has an existing sequence. Candidate duration is 3230 seconds and size is 569829020 bytes. The pending cache is 605 tracks, 134913 seconds, and 23531408853 bytes. A successful candidate would update that cache to 592 tracks, 131683 seconds, and 22961579833 bytes, while creating the separate edition with the removed totals.

Both stale-path and forced late-invariant Wrangler rehearsals aborted with the hard failure sentinel. After each failure, the local fixture retained zero candidate albums and all 13 masters remained pending.

The 13 人声/言和 track pairs have different WAV byte sizes. Twelve pairs also have different decoded whole-second durations; the remaining pair has sizes 66846236 and 66855644. This rules out a byte-identical WAV asset for every pair, but does not by itself prove an exact PCM comparison. The two vocal editions must remain separate until direct PCM hashes are captured; no retirement candidate is safe.

Direct R2 read-only streaming verification decoded every one of the 26 WAV objects to canonical s32le PCM. All thirteen human/言和 track pairs have different SHA-256 PCM hashes. Both editions must be retained as distinct recordings; no tag merge or object retirement is authorized.

The double-edition candidate creates two 13-track albums and one display group without changing audio masters, instances, or R2 objects. Local Wrangler success completed all hard row-count checks. Stale-path and forced late-invariant fixtures both aborted atomically, leaving zero target albums and all 26 tracks pending. Final primary preflight still reports pending 581/129701/22611646437 and each edition as 13 active scanned WAV tracks without disc or track values.


## Exact double-edition candidate closeout

The final candidate is driven by a 26-row production `VALUES` snapshot. Its first statement checks every captured master, instance, object, and entry field, including identities, associations, source/storage URI, status flags, titles, both durations and sizes, path/display name/kind, and physical key. It also checks the current pending aggregate `581/129701/22611646437`, one-to-thirteen track coverage for each edition, and absent target album/group IDs. The sole master UPDATE names only those 26 snapshot IDs; the final sentinel checks both 13-track albums, exact aggregate totals, two display-group members, and all 26 ID assignments with unique edition/track positions.

Local Wrangler 4.79.0 rehearsals against isolated D1 fixtures: success completed with 2 albums, 1 display group, and pending `555/123211/21466454141`; a changed entry path failed with integer overflow and left 26 candidate masters pending and no target albums/group; a trigger that moved one master during the update failed the final integrity sentinel and rolled back the batch, leaving the same untouched fixture state. A local SQL `BEGIN` probe is rejected by Wrangler/D1; no explicit transaction syntax is used.

The production primary preflight executed the saved three-query SELECT-only SQL file. Wrangler reported primary service, 223 rows read, and 0 rows written. Separate primary reads confirmed pending `581/129701/22611646437` and exactly 26 candidate tracks split 13/13. No production write was issued. A separate controlled remote D1 batch probe by the parent agent also confirmed that a forced late integer overflow rolls back both inserted markers; this is recorded separately from the local rehearsal.

All thirteen human/言和 track pairs remain distinct by canonical PCM SHA-256. Both editions remain separate albums in one display group; no audio rows or R2 objects are changed by the candidate.
