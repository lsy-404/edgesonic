# Findings

This is a read-only production audit. No production D1 mutation, R2 upload, or R2 deletion is authorized.

Production primary inventory contains 142 active audio files in scope: 114 under the Days collection, 20 under 三月雨, and 8 under 忆香. No active indexed file was found under the three requested independent root names 失落的机械城, Summer Days, or 失落的机械城Ⅱ.

`Days幻梦年华乐团合集/2-Summer Days` is an independent release candidate: its WAV vocal directory contains exactly eight files numbered 01 through 08 and remains in `pending-uploads`; its MP3 vocal directory contains exactly seven overlapping songs in `al-2b21b237dc`. The WAV-only 01 序曲 is part of the WAV edition. The candidate excludes the other Days subdirectories, accompaniment, masters, and bonus tracks.

All seven overlapping WAV/MP3 pairs were retrieved read-only from production R2 and decoded to 44.1 kHz stereo signed-16 PCM. Their SHA-256 values differ. These are distinct codec editions, not proven lossless duplicates, so all audio objects and masters must remain. A safe future D1 operation may create a separate WAV album and place it with the existing MP3 album in one display group, with exact source and aggregate guards.

The guarded candidate creates `al-summer-days-wav`, assigns exactly the eight reviewed WAV masters as disc one tracks one through eight, recalculates the pending and WAV album caches, and creates a two-member display group with `al-2b21b237dc`. It does not update any R2 object, file entry, accompaniment, master edition, or bonus track.

Fresh primary read-only preflight returned eight exact pending WAV source rows, eight files in the reviewed source folder, zero target-album rows, one matching seven-track MP3 album, and zero existing MP3 display-group memberships. The response was primary-served with zero rows written.

Wrangler local D1 rehearsals used an isolated fixture derived from the exact source snapshot. The candidate succeeded with eight WAV tracks and two display members. A second execution failed at the initial stale guard and preserved the prior state. A separate final invalid queue-row statement failed after the candidate body; D1 rolled the full batch back, leaving zero target tracks, eight pending tracks, and zero display groups.
