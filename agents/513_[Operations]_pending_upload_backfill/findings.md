# Findings

## Final candidate

- Safe-only manifest: 33 independent source-parent-codec groups / 310 masters. Every group has a unique target album ID derived from the runtime helper and a literal source-folder label. No title deduplication, R2 operation, sidecar update, or unrelated-row update is included.
- Final `manifest_safe.json` SHA-256: `1fafd3214b643a4ef27529adae3c524aca21a8aaba42b16a5f443e5f07a99c66`.
- Final `candidate_map_safe.json` SHA-256: `b60e703efafc69a4bd0b6f188c9435e49d9f46c3c5fda81643eccf86066975f5`.
- Manifest says 752 of the refreshed 1,062-master pending cohort are excluded from this operation; those include 601 held candidate masters plus 151 earlier no-entry/disc/bonus/quality-root exclusions. The live album catalog changed during the investigation, so do not use a static whole-library album count as a guard.
- Fresh production-primary read-only preflight: 33/33 PASS, 310/310 exact pending masters and storage links, zero target collisions, title/track conflicts, or unallowlisted sibling masters. Served by primary; `rows_written=0`. Timestamp in `preflight_summary_safe.json`.
- Local SQLite rehearsal: all 33 groups applied, early rollback restored all 310, late rollback preserved an external member and its cover/annotation/display-group reference, stale state failed closed. No production apply was run by this task.

## Guard change for D1

The initial apply/rollback files used `CREATE TEMP TABLE` as a temporary assertion mechanism. Cloudflare D1 rejected that DDL with `SQLITE_AUTH` before any production mutation. Primary verification after the failure showed 0 candidate rows moved and all 12 first-batch rows still pending.

The final generator uses an `INSERT INTO work_queue ... SELECT ... WHERE NOT (guard)` with deliberately invalid status `guard_failed`; `work_queue.status` has a CHECK constraint excluding that value. A passing guard inserts no row. A failed guard raises a constraint error before any album/master write. Per-master writes have a `changes()!=1` assertion; the final aggregate check requires two album rows updated and the expected target count/song_count/size. Rollback has an initial whole-group storage-link guard, per-master assertions, and a final pending/target membership check. The final manifest contains these regenerated statements.

## Identity exclusions and holds

Groups are held as a whole on any ambiguity. This includes the 13-track `忘川风华录·数风流` group because after removing filename track numbers its 13 titles match the existing `数风流` album in the same order. Name review also holds strong edit-distance/prefix/version collisions such as `Freesia` versus `Fressia`, `夜幻寻梦    夢ノ結唱`, `页间曲-星韵社`, the 夏浪 event variants, both `你的灵魂长出一支玫瑰` versions, `依路相随（二刷）不羁阁`, and `追光逐影`.

`similar_name_audit.json` compares all 111 original candidate group names to the primary album-name snapshot after NFKC/casefold/alphanumeric normalization. It records nearest strong prefix/edit-distance matches. Generic short labels were not treated as identity proof. `stripped_title_results` records primary read-only queries comparing candidate titles with leading track numbers removed against non-pending album tracks. Apart from the held 13-track sequence, two isolated exact title overlaps were found; these are not enough to infer same-release identity or to deduplicate audio.

## Metadata still missing

All final 310 masters have null `track` and `disc` snapshots. Of these, 257 titles have a numeric filename-style prefix; 243 masters across 25 groups have a numeric prefix on every track with unique indices. The remaining 67 masters are in mixed/unprefixed groups. A later guarded metadata operation can consider only the 243 fully numbered masters after checking exact per-group index sets and the single-disc assumption. This backfill deliberately preserves title strings and does not set track/disc values. Twelve of the final 310 titles have a literal `Track ##` prefix; their descriptive suffix is present, but the prefix remains in the stored title.

## Sidecars and references

The candidate SQL changes only `song_masters.album_id` and recomputes `albums.song_count`, `albums.size`, and `updated_at`. It leaves every master, instance, object, storage entry, queue row, lyric row, playlist/annotation reference, and R2 object in place. It does not associate cover/CUE/LRC/image storage entries with a new album or track. The read-only parent-level inventory records six CUE and one lyric entry under parents containing safe candidates; because parents can contain multiple candidate folders, these counts are not assigned to a particular release. `追光逐影` remains held pending an explicit cover/lyric/CUE association plan.

## Execution notes for the parent

1. Verify the manifest SHA and `candidate_map_safe.json` SHA above before executing anything; `manifest_safe.sha256` records the current manifest digest. Do not regenerate the manifest or any `batches_safe` SQL while applying.
2. Each manifest group is one independently guarded D1 file. Apply one `batches_safe/apply/<batch_id>.sql` at a time; stop on any Wrangler error. The first batch failure proved the old temp-table files are obsolete; use only files listed in the final manifest.
3. After each successful apply, run the matching `batches_safe/postflight/<batch_id>.sql` as SELECT-only and require the full expected membership, stored song count, and calculated size. Save the result as an execution receipt with batch ID, manifest SHA, apply-file SHA, result, and timestamp. Do not blindly retry: a repeated apply should fail its pending-state guard; inspect primary first.
4. If a batch needs reversal, use only the matching `batches_safe/rollback/<batch_id>.sql`; it restores only exact candidate masters and deletes the empty target album only if no outside master, display-group member, or annotation references it. Then run that batch's postflight and check both expected sides.
5. After all 33 batches, run `postflight_total_safe.sql` and `postflight_excluded_safe.sql`. Require 310 expected candidates moved, 310 still-pending candidates reduced to zero, 33 target albums at expected sizes, and 752 excluded-snapshot rows still pending. Re-read primary before any later metadata or sidecar operation.

The final GO applies only to guarded album-ID assignment for these 310 masters. Track/disc metadata and sidecar association are separate follow-up operations.

## Approved safe groups

| Album folder label | Masters |
|---|---:|
| AI绫 | 10 |
| FM404 | 9 |
| OTOME | 9 |
| SE＞EN(Sya)SEVEN | 10 |
| Stay | 7 |
| Still With U | 13 |
| bilibili 乙巳蛇年拜年纪：跨越数千昼夜 | 16 |
| cop十周年纪念专辑 | 16 |
| sakuya薯片~THE NOCTURNE | 8 |
| 世界沉睡童话 | 5 |
| 人造树的幽灵 | 8 |
| 众虫皆歌 | 10 |
| 低语者 | 8 |
| 兰音.2024.《形神合一》 | 10 |
| 哈利波特·学院印象曲 | 10 |
| 四季有时 | 5 |
| 回声漫过荒原 | 10 |
| 如期归还 | 12 |
| 实力至上-奇怪雷子QGRay | 10 |
| 幽灵摄影 | 10 |
| 心语 | 10 |
| 忘川风华录·溯洄 | 10 |
| 旧未来ЯEMIXTION | 12 |
| 星座-扑克 | 12 |
| 春华秋拾 | 4 |
| 洛天依的构成 | 7 |
| 花と約束 | 5 |
| 衔风与愿 | 1 |
| 被那个夏天厌恶的我们 | 7 |
| 赏味期限 | 11 |
| 逆进化ЯEVOLUTION | 10 |
| 黑猫出现在白天-七点半 | 14 |
| 黑白 | 11 |
