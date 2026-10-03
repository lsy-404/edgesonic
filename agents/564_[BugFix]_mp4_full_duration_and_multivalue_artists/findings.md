# Findings

- Existing `runMetadata` accepts a positive partial MP4 duration and only performs the capped full-file fallback when metadata is empty or an `.mp4` path lacks duration. This misses `.m4a`, `.m4b`, and `.alac` and does not reject truncated duration values.
- `runMetadata` and browser-local `extractMetadata` serialize only `common.artist`; `music-metadata` can expose multiple performers via `common.artists`. The backend already splits comma/semicolon-delimited names into ordered credits.
- Production evidence established two distinct native artist values, but source evidence supports only one primary performer. Tests use generic synthetic values; no private audio bytes will be copied into tests or commits.
