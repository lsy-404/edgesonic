# Findings

Production-primary D1 inspection covered every entry, instance, stable object, sidecar, and matching album name for the four requested paths. The queries returned zero D1 rows written. R2 `get --pipe` read both CUE sidecars without downloading them to disk.

| Physical directory | Result | Evidence |
| --- | --- | --- |
| `蔗蓝的创作集1.0-蔗蓝（wav）` | Safe local candidate | One root, 28 present scanned WAV instances, 28 unique numeric positions, and the CUE declares 28 tracks in the same order. No existing artist or album with the target identity was found. The CUE object is retained. |
| `幸福三部曲 - VOICEMITH/CD_mastered_CN` | Hold | Fifteen WAV files mix five vocal/instrumental pairs with later vocal tracks numbered 06, 07, 08, and 15. The gaps and repeated positions do not establish one linear album sequence. |
| `夜幻寻梦    夢ノ結唱` | Hold | The physical folder has a 15-track vocal/instrumental set plus five duplicate Unicode-normalization filename variants. Eight related FLAC masters already occupy three fragmented `夜幻寻梦_Midnight Revereies-α` albums. No PCM comparison has yet shown whether the WAVs are the same masters. |
| `依路相随 CD/wav` | Hold | Nineteen WAV instances have a CUE sidecar, but its album title is blank and its filenames/title fields are only numeric placeholders. It cannot safely supply album or artist identity. |

## Candidate: 蔗蓝的创作集1.0

`apply_zhulan_collection.sql` is a local-only D1 candidate. It guards the exact 28 master IDs, their pending state, source/codec/tag state, fixed physical parent, 30-entry physical tree, and CUE entry/object. Its refreshed primary preflight verified the current pending cache (`641`, `141395`, `24700222725`) equals an independent recomputation and embeds those exact pre-state cache values in the candidate guard. It rejects a pre-existing target artist or album. There is no cover entry or master cover association under this root; the CUE is the sole sidecar and stays unchanged. It creates `ar-abdf58605e` and `al-fe198b18b1`, assigns all 28 masters with tracks 1–28 on disc 1, and recomputes the pending and target album caches. It writes no R2 data and does not modify entries, objects, instances, lyrics, or sidecars.

The isolated Wrangler D1 fixture exercised the candidate directly. Success produced one 28-track album (tracks 1–28) and zero pending masters. A source-state change failed the first guard before any target album was created. A marker-induced failure after all cache recomputation rolled the entire candidate back: zero target albums, zero target masters, and all 28 source masters still pending.
