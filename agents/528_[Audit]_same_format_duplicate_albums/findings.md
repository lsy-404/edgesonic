# Findings

## Production capture

The bounded D1 reads were primary-served SELECTs with zero rows written. The first album query used the obsolete `total_size` name and failed without changing D1; `albums.size` is the current column. The selected sets contain 93 original FLAC instances across ten album rows. `production_inventory.json` records the selected D1 catalog rows and `production_companions.json` records 160 source-tree entries.

## Decoded PCM result

Every aligned pair decodes to a different signed-32-bit PCM SHA-256. This includes tracks that have equal decoded byte counts and sample rate. Equality of title, duration, suffix, or decoded byte length is therefore insufficient here: all 41 aligned comparisons differ in PCM content.

| Set | Aligned pairs | Exact PCM pairs | Decision |
| --- | ---: | ---: | --- |
| Lost in Tianyi / Lost In Tianyi | 9 | 0 | Keep both editions. The 2018 tagged folder and the separate reconstruction folder use different masters. |
| 华哉有夏·贰 | 8 | 0 | Keep both editions. Artist, album-artist, year, directory, and tag completeness differ. |
| 洛 LUO | 5 | 0 | Keep both editions. One is 96 kHz and one is 44.1 kHz, with different decoded PCM and artist/tag provenance. |
| 无事发生 | 11 vocal-title alignments | 0 | Keep both editions. The 22-track tree also contains eleven accompaniment tracks, separate lyrics and covers. |
| 夢境之森 | 8 | 0 | Keep both discs. Disc B titles are explicitly marked `米库喵 Ver.` and carry a different artist identity. |

## Directory, tag, and companion evidence

- Lost in Tianyi uses two separate roots. The 2018 root contains cover artwork plus LRC/TXT sidecars, while the reconstruction root has a separate nine-file FLAC set.
- 华哉有夏·贰 uses separate roots. The 2021 tree includes eight LRC sidecars and artwork; the older tree is an independent eight-FLAC source.
- 洛 LUO shares one broader source root but has a 96 kHz Official-tagged set and a 44.1 kHz tagged `flac` set, with separate cover and lyric sidecars.
- 无事发生 uses two source roots. The 22-track root has paired LRC files, multiple cover assets, and vocal/accompaniment material; it is not a redundant 11-track copy.
- 夢境之森 is one package with Disc A and Disc B. The package naming, track suffixes, artist tags, and PCM all distinguish the discs.

## Remediation boundary

No guarded production SQL candidate was generated. A candidate that moved masters, instances, or album ownership would conflate distinct audio and metadata. Consequently, success/stale/late-failure Wrangler rehearsal is not applicable. No production D1 write, R2 write, or R2 deletion occurred; the downloaded objects were temporary and removed after hashing.

## Display-group follow-up

The final primary SELECT-only preflight confirms that every selected album is already in the intended two-member display group, with the expected member order and with the album's declared song count matching both master and available original-instance counts.

| Set | Current display group | Result |
| --- | --- | --- |
| Lost in Tianyi | `ag-lost-in-tianyi` | Both nine-track editions grouped. |
| 华哉有夏·贰 | `ag-huazai-youxia-2` | Both eight-track editions grouped. |
| 洛 LUO | `ag-luo-2023` | Both five-track editions grouped. |
| 无事发生 | `ag-nothing-happened` | The 22-track vocal-plus-accompaniment edition and 11-track edition are grouped. |
| 夢境之森 | `ag-dream-forest-2016` | Disc A and the separately credited Disc B vocal edition are grouped. |

No candidate was generated and no local success/stale/late-failure rehearsal was run: an insert candidate would fail its required unoccupied-member guard and could not be a valid success case. The existing groups preserve every album, master, instance, object, tag, sidecar, and directory relationship.
