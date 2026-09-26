# Local Wrangler rehearsal receipt

| Scenario | Result |
| :-- | :-- |
| Complete snapshot | One standalone album, ten tracks with disc 1 and sequence 1 through 10, no remaining pending candidate masters |
| Stale first path | No album created; all ten candidate masters remain pending |
| Reassigned final master | No album created; nine candidate masters remain pending and the final master retains its competing assignment |
| Forced late invariant failure | Wrangler aborts the atomic file; no candidate album is left and all ten candidate masters remain pending |

The rehearsal used Wrangler's local D1 execution path. Production execution was not performed.
