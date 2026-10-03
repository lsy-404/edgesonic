# Task plan

- [x] Inspect metadata work queue paths, existing partial-read behavior, and artist credit serialization.
- [x] Require a complete bounded read before accepting MP4-family duration from a ranged response; retain tags but omit untrusted duration on read/parse failure or over-cap objects.
- [x] Preserve every distinct `common.artists` value in both browser-local extraction and worker wire serialization.
- [x] Add synthetic MP4-family regression cases for positive partial duration, successful full read, failed/short full read, over-cap behavior, and multivalue artist ordering.
- [x] Run focused tests and type checks; record evidence and any remaining limits.
- [x] Commit the isolated branch for root integration.
