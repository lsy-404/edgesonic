# Production receipt

The parent task executed the guarded candidate against production D1 using the reviewed `apply.sql` SHA-256 `7773335A8A42856A3053EA2B5384615C885AAFAC5FA8F6D8B57778EE0E8B9A18`.

- Wrangler exit code: 0
- Statements: 11
- Rows written: 66
- Served by primary: true
- This receipt-writing follow-up did not issue any production write.

An independent primary postflight reported:

- Find-Zero (WAV): 25 songs; disc 1 tracks 1–14; disc 2 tracks 2, 3, 4, 5, 6, 8, 9, 10, 11, 13, 14; duration 6014 seconds; size 1,146,267,102 bytes.
- Find-Zero (WAV) source integrity: all 25 master, instance, storage-object, and entry references remain intact.
- Existing Find-Zero (FLAC): 14 songs; duration 3173 seconds; size 411,082,170 bytes.
- Display group: two editions, FLAC sort 0 and WAV sort 1.
- Pending uploads: 652 songs, duration 143,817 seconds, size 25,247,901,901 bytes.
- All three album caches equal their recalculated source totals.

The candidate retains both audio editions because all 14 decoded WAV/FLAC PCM pairs were distinct. No production rollback or additional write was performed by this follow-up.
