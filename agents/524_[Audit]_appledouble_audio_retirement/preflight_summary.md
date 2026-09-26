# Fresh primary preflight

The primary D1 read completed without writes.

| Item | Result |
| --- | --- |
| Masters | `sm-upload-1dad3581-327`, `sm-upload-bc490030-464` under `pending-uploads` |
| Instances | one original `r2-local` WAV instance each, both 176 bytes |
| Tree entries | two files under one `遇依 成曲/__MACOSX/成曲/成曲` subtree |
| Other references | no child instances, transcodes, playlists, annotations, or song-artist rows |
| Queue | two matching completed metadata rows, retained by the candidate |
| Recovery material | both stable R2 objects and their `storage_objects` rows remain |

The latest primary query matched all guarded fields: 2 masters, 2 instances, 2 leaf entries, 3 ancestor folders, 2 recovery objects, and 2 completed queue records. It was served by the primary and wrote zero rows. The stored names are intentionally the source's mojibake values (for example `鎴愭洸`), and the candidate uses those exact values.

The local retrieved object bytes begin with AppleDouble magic `00 05 16 07`, version `00 02 00 00`, and the `Mac OS X` filler. Neither begins with the WAV `RIFF` signature.
