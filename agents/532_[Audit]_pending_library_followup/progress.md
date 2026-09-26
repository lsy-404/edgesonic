# Progress

- Started a new audit branch from the latest main revision.
- Ran corrected local Wrangler stale and forced late-failure rehearsals; each rolled back cleanly.
- Ran primary-only production preflight and recorded current fields and expected aggregate cache deltas.
- Compared all thirteen 人声/言和 pairs through primary D1. Every WAV byte size differs, so no pair is eligible for byte-level duplicate retirement.
- Streamed all 26 R2 WAV objects into ffmpeg and recorded canonical PCM hashes; all thirteen pairs differ.
- Added and rehearsed the guarded double-edition display-group candidate, including stale and late-invariant rollback cases.
- Rechecked the production primary snapshot without writes.

- Re-captured the full 26-row primary snapshot with all master/instance/object/entry fields; generated the exact `VALUES` guard and SELECT-only preflight artifact.
- Local Wrangler success: 2 editions with 13 tracks each; pending aggregate becomes 555 / 123211 / 21466454141.
- Local Wrangler stale path: hard sentinel fails; verification query shows 0 target albums, 0 groups, all 26 tracks pending, and original aggregate retained.
- Local Wrangler late trigger: final integrity sentinel fails; batch rollback verified with the same untouched-state query.
- Production primary SELECT-only preflight: 3 SELECT queries, 223 rows read, 0 rows written; pending remains 581 / 129701 / 22611646437 and candidates remain 13 + 13.
- The candidate and its audit artifacts are ready on the existing branch; root-level Wrangler state directories and `/agents/project.md` / `/agents/tasks.md` are excluded from the commit.
