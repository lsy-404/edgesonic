# Object title repair audit

## Evidence and data conclusion

The first production inventory found no titles exactly equal to `obj` or beginning with `obj_`. The expanded read-only inventory returned zero rows for all three groups: object-like/garbled titles, object-like storage-entry names or paths, and empty/unknown titles. A separate production `search3` sample with an empty query returned 0 object-like song titles but 499 physical `objects/obj_*` paths among 500 songs. The broader check found logical paths for all 5,767 original object-backed instances examined. No production title update is supported or needed from the observed data; the demonstrated issue is API path presentation.

All production queries were read-only and reported no database writes. No repair or production write was performed.

## Parser follow-up review

The latest parser commits address the previously reported behavior changes:

- `/tag/submit-upload` again rejects cleaned empty metadata unless a readable logical filename can supply a track title. Physical object keys and generated object-like basenames are rejected by the shared helper, so they cannot satisfy the empty-submit exception.
- `/tag/read` only enters filename fallback when the current title is empty/object-like/lossy and a readable logical basename exists, or for pending uploads with a readable title. It applies only the recovered title in that fallback branch. With no parseable tags and no qualifying filename fallback, the instance remains on the no-usable-tags path.
- Song query projections now select a logical path only when exactly one file entry is linked to the selected instance. `getSongMaster`, song lists, search rows and selected song instances carry that path. `mapSong` uses it for `Child.title` recovery and `Child.path`, falling back to the physical URI only when no unambiguous logical path exists. The search3 XML/JSON regression covers physical object URI, placeholder title recovery, logical path output, and preservation of known titles.
- Search result rows are selected from a materialized page before the logical-path scalar query, bounding the new indexed `storage_entries(instance_id)` lookup to requested song rows. The storage-entry instance index exists. Album listing also gets a path by repeating the preferred-instance selection; its two subqueries do not include a deterministic final tie-breaker, so tied instances could theoretically provide a physical URI from one row and an album-recovery path from another. This is limited to fallback album display metadata and is not a blocker for the song path fix.

No substantial blocker was found in the latest code reviewed. Query/type wiring and path presentation are internally consistent for song rows. The observations are code review only; this audit did not execute the test suite.
