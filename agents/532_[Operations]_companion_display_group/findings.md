# Findings

## Primary snapshot and preflight

- The vocal album has ten WAV masters on disc 1, tracks 1–10. Its stored cache is `10 / 0 / 354704714`; actual rows are `10 / 2010 / 354704714`. The guarded batch refreshes its duration cache to 2010 seconds.
- Ten accompaniment WAV masters remain pending with null disc/track. Their original titles, durations, source and tag state, instances, objects, physical keys, entries, parents, and paths are captured in `snapshot.json`; measured duration and instance-size totals are 2037 seconds and 387524512 bytes.
- The initial captured snapshot had pending `581 / 129701 / 22611646437`. Other archive jobs completed before final preflight. The latest primary preflight returned `549 / 122071 / 21265357877`, matching actual rows; after the ten accompaniment masters move, the expected pending cache is `539 / 120034 / 20877833365`.
- The final primary SELECT-only preflight matched all 20 target rows exactly. The vocal and pending aggregates matched the observations above; album, group, and member conflicts were all zero. All three queries reported `served_by_primary=true` and `rows_written=0`.
- No alternate version is deleted or rewritten. The batch gives the ten accompaniment masters disc 1 tracks 1–10, creates a standalone accompaniment album, and adds the vocal and accompaniment albums as the two ordered members of one display group.

## Atomicity and local rehearsal

- The candidate repeats exact source and aggregate guards before each mutation stage, asserts affected-row counts, refreshes the pending, accompaniment, and vocal caches from actual rows, and checks titles, durations, file identities, album metadata, track ordering, and group membership at the end.
- True Wrangler local rehearsal passed on the final primary aggregate for success, a stale storage path, a concurrent master reassignment, and an invalid final `work_queue` insert. For the late failure, SHA-256 fingerprints over every fixture table matched before and after the failed file execution; caches and memberships also remained unchanged.
- The previous candidate/fixture's accompaniment size `387655512` was stale. The new candidate and fixture use the current captured target rows totaling `387524512`.
