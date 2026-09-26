# Production receipt

The repository operator executed the A-edition candidate with Wrangler against production. Wrangler exited successfully after five queries and reported 14 rows written. A separate primary postflight verified:

- Album `al-86f72c214f`: 8 tracks, duration 1,540 seconds, size 271,656,352 bytes.
- Pending cache: 549 tracks, duration 122,071 seconds, size 21,265,357,877 bytes; cached values agree with live aggregates.
- All eight WAV source instances, storage entries, and physical objects remain intact; tracks 1–8 are unique.

The two pre-existing anchor masters, track 3 `系统万象` and track 4 `致邀请老用户`, still have `disc=NULL`. The six newly assigned masters have `disc=1`. A guarded local-only correction is being prepared to set the two anchors to disc 1; it has not been run against production.

Primary read-only follow-up also confirms the B folder still contains 16 pending WAV files, in numbered positions 1–16, and that no B album or A/B display group exists yet. The A edition (8 tracks, including two bonus tracks) and B edition (16 tracks, including Narrator/Mobile variants and a separate cover) should remain separate albums and later become members of one display group. Do not create an empty group before B has been archived.
