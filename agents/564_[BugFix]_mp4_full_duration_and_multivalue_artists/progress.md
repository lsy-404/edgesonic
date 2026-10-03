# Progress

- Created isolated task record on `codex/m4a-complete-read` from `419d0bb9ba26f3537fadc9747d03d7cba63b928d`. Dependencies are read through a junction to the existing repository `node_modules`; no package installation occurred.

- Updated `web/src/workers/taskExecutor.ts`: partial MP4-family (`m4a`, `m4b`, `mp4`, `alac`) durations are ignored until an exact-size 200 full response parses successfully; the additional read is limited to 300 MiB. Failed, short, over-cap, or duration-parse-failed full reads keep ranged tags and omit duration. Other-format empty-tag fallback remains bounded and unchanged in purpose.
- Added shared `commonArtistsToTag` serialization to browser-local extraction and worker output. It prefers ordered plural values, deduplicates case-insensitively, joins with the delimiter consumed by existing `parseArtistCredits`, and falls back to singular artist metadata.
- Added synthetic regression coverage to `test/frontend/metadata_duration_partial_mp3.test.ts`: positive ranged M4A duration; full-file duration for M4A/M4B/MP4/ALAC routes; failed, short and over-cap reads; retained ranged tags; plural performer ordering and backend credit parsing. No private audio was used.
- Validation: `npm run typecheck -w web` passed; `npx tsx test/frontend/metadata_duration_partial_mp3.test.ts` passed all cases; `git diff --check` passed.
- Follow-up review: omitted bitrate remains absent through `cleanInput`; `metadataApply` updates the stored bitrate only when a trusted duration-derived or submitted positive bitrate is available. Partial MP4-family bitrate is now omitted until the full read succeeds, with failed, short, over-cap, and complete-read regression cases. The full-read case verifies a positive bitrate is still submitted.
- Follow-up validation: `npm run typecheck -w web`, `npx tsx test/frontend/metadata_duration_partial_mp3.test.ts`, and `git diff --check` passed.
