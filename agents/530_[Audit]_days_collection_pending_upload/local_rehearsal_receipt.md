# Local Wrangler receipt

Candidate SHA-256: `bd86997aafcb3f4213a93ef0d2a2ac3d1706541c5d0d4ac2fcb505387bfc1693`.

- Success fixture applied the candidate with eight WAV target tracks, two display members, and a recalculated MP3 duration of 2023 seconds.
- Reapplying that exact candidate to the already-applied isolated database failed at the initial invalid queue-row guard. The prior state remained eight target tracks, zero pending fixture tracks, one display group, and MP3 duration 2023.
- A newly seeded isolated database ran the same candidate with an intentionally invalid final queue-row insert. Wrangler rejected the batch; the post-failure read returned zero target tracks, eight pending tracks, zero display groups, and MP3 duration 0. The entire candidate body was rolled back.
