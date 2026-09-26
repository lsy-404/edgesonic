# Findings

Production-primary D1 inspection covered every entry, instance, stable object, sidecar, and matching album name for the four requested paths. The queries returned zero D1 rows written. R2 `get --pipe` read both CUE sidecars without downloading them to disk.

| Physical directory | Result | Evidence |
| --- | --- | --- |
| `蔗蓝的创作集1.0-蔗蓝（wav）` | Safe local candidate | One root, 28 present scanned WAV instances, 28 unique numeric positions, and a 28-track CUE in the same order. No existing artist or album with the target identity was found. The CUE object is retained. |
| `幸福三部曲 - VOICEMITH/CD_mastered_CN` | Hold | Fifteen WAV files mix five vocal/instrumental pairs with later vocal tracks numbered 06, 07, 08, and 15. The gaps and repeated positions do not establish one linear album sequence. |
| `夜幻寻梦    夢ノ結唱` | Hold | The physical folder has a 15-track vocal/instrumental set plus five duplicate Unicode-normalization filename variants. Eight related FLAC masters already occupy three fragmented `夜幻寻梦_Midnight Revereies-α` albums. No PCM comparison has yet shown whether the WAVs are the same masters. |
| `依路相随 CD/wav` | Hold | Nineteen WAV instances have a CUE sidecar, but its album title is blank and its filenames/title fields are only numeric placeholders. It cannot safely supply album or artist identity. |

## Candidate: 蔗蓝的创作集1.0

`zhulan_primary_snapshot.json` captures all 28 candidate master, instance, object, storage-entry, path, title, and physical-key fields from production primary. `generate_candidate.py` builds the local-only rehearsal candidate and the SELECT-only preflight from that snapshot. The preflight checks all 28 rows field-by-field using NULL-safe equality, a unique 1–28 position sequence, the exact root entry and 30-entry tree, the CUE entry and object, absence of target identity conflicts, and the pending-cache snapshot against independent sums.

The final primary preflight observed `633` pending masters, `139321` seconds, and `24334446389` bytes; independent recomputation matched all three values. It matched all 28 candidate rows, all 28 unique positions from 1 through 28, the 30-entry physical tree, and the exact CUE object key `objects/obj_568cc33144589d95.cue` (suffix `cue`, size `4649`). It found no target artist or album conflict. The D1 response identified the primary, reported `rows_written=0`, and `changed_db=false`.

The candidate creates artist `ar-abdf58605e` and album `al-fe198b18b1`, assigns the 28 masters to tracks 1–28 on disc 1, and recomputes pending and target album caches. It performs no deletes and contains no updates to storage entries, storage objects, song instances, lyrics, or sidecars. It is a local rehearsal artifact; it has not been executed against production.

Wrangler local rehearsal results:

- Success created one album with 28 masters; tracks were unique and continuous from 1 to 28. The album cache was `28 / 4408 / 803037536`; pending became `605 / 134913 / 23531408853`.
- Stale-source rehearsal changed one captured title. The first guard failed with a CHECK constraint; no target artist or album was created, all 28 remained pending, and the changed title remained intact.
- Late-failure rehearsal inserted the deliberate marker that triggers the final guard after album and cache updates. The CHECK failure rolled back the full candidate: zero target artist, album, or masters; all 28 remained pending; the 29 child entries and marker remained intact.

Fixture setup initially exposed a local schema mismatch; the test fixture was corrected before the three recorded rehearsals. No production mutation was issued.
