# Findings

Production D1 and R2 are read-only. A same-title file is not treated as the same recording until exact lossless PCM evidence establishes that relationship.

`洛天依共鸣合集` contains pending MP3 files alongside already grouped WAV editions, so it remains audit-only. The rose release has separate 13-track 人声 and 言和 WAV editions. The 人声 folder is complete, active, scanned, sequential by filename, and entirely pending; the guarded candidate creates a standalone 人声 edition without touching the 言和 edition or merging PCM.

The final primary preflight found 13 masters, instances, and objects; every instance is an active scanned WAV and no candidate track has an existing sequence. Candidate duration is 3230 seconds and size is 569829020 bytes. The pending cache is 605 tracks, 134913 seconds, and 23531408853 bytes. A successful candidate would update that cache to 592 tracks, 131683 seconds, and 22961579833 bytes, while creating the separate edition with the removed totals.

Both stale-path and forced late-invariant Wrangler rehearsals aborted with the hard failure sentinel. After each failure, the local fixture retained zero candidate albums and all 13 masters remained pending.

The 13 人声/言和 track pairs have different WAV byte sizes. Twelve pairs also have different decoded whole-second durations; the remaining pair has sizes 66846236 and 66855644. This rules out a byte-identical WAV asset for every pair, but does not by itself prove an exact PCM comparison. The two vocal editions must remain separate until direct PCM hashes are captured; no retirement candidate is safe.

Direct R2 read-only streaming verification decoded every one of the 26 WAV objects to canonical s32le PCM. All thirteen human/言和 track pairs have different SHA-256 PCM hashes. Both editions must be retained as distinct recordings; no tag merge or object retirement is authorized.
