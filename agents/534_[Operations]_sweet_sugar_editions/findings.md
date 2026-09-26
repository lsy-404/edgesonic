# Findings

- The prior exact-byte deduplication retained all distinct MP3 and FLAC recordings but left 23 masters in one album. This did not provide the two selectable editions requested by the user.
- The production primary snapshot had 12 MP3 masters on disc 1, tracks 1–12, and 11 FLAC masters with tracks 2–12 and null disc. FLAC has no Intro. The existing album cache matched all 23 masters at 5513 seconds and 410713535 bytes.
- User-provided PCM classification says the matched MP3 and FLAC audio differs. Both sets were retained. No audio or logical file row was deleted in this operation.
- The former FLAC album ID is the deterministic album ID for the artist and album tag. Its cover key still exists in R2: 48536 bytes, SHA-256 `F53C45BA64A5EA685686E7838410606997F64C98916EF14087AA66006D8AC6C7`.
- The exact 23-row primary preflight matched master, instance, storage object, and storage entry identities; target album and display group had no conflicts, and no active scoped work existed. All five queries returned `served_by_primary=true` and `rows_written=0`.
- The batch recreated the FLAC album as `Sweet Sugar (FLAC)`, retained the MP3 album name, assigned disc 1 to FLAC tracks, and grouped the two albums under `Sweet Sugar`. This keeps the MP3-only Intro and the original cover keys.
- Python in-memory success, stale-object, active-work, and late-failure tests passed; the failure cases preserved the complete fixture fingerprint. Wrangler local accepted the fixture and successful candidate. Production remote execution then succeeded and its independent primary postflight matched both album caches, ordered group membership, all 23 master/instance/entry/object links, track indices, and scanned/nonmissing state.
