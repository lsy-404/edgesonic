# Production receipt

- Candidate SHA-256: `FCC2DF82C31E4891221F4E2A3357D086777132D2BD35D997A7F130BA24E0CFEE`.
- Snapshot SHA-256: `A3CDBA6E1442736F001C901EE2BCE02CF8D72239361E802B61B239044D155B2A`.
- Remote Wrangler D1: exit 0, 13 queries, 37 rows written, `served_by_primary=true`, bookmark `000039ea-00000080-000050f2-364e081d42019db7314b07bdac22996f`.
- Independent primary SELECT postflight: MP3 12 / 2775 seconds / 44989327 bytes; FLAC 11 / 2738 seconds / 365724208 bytes; stored and actual aggregates match.
- Display group has the MP3 album at sort order 0 and FLAC at 1. Their 23 masters have 23 instances, 23 storage entries, and 23 storage objects; every instance is scanned and nonmissing. MP3 tracks are 1–12, FLAC tracks 2–12, each on disc 1. All 23 entries retain the original `Sweet Sugar/` paths.
- Postflight queries reported `served_by_primary=true`, `rows_written=0`.
