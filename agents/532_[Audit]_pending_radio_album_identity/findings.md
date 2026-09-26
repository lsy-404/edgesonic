# Findings

## Decision

The six pending files in `矩尺镜海·蚀刻于此媒介A` are a bounded safe cohort for completing the existing A edition. The directory has an explicit A suffix, its six pending rows occupy numbered positions 1, 2, 5–8, and positions 3–4 are already linked to the existing `矩尺镜海·蚀刻于此媒介A` album. The sibling B directory has its own sixteen-file sequence and its own cover; overlapping names such as `信号心桥`, `答案不唯一`, `Sublimity`, and `系统万象` confirm that A/B are distinct editions. The proposal touches only six A entries and retains the two existing anchors.

`梦境电台` is held. The 24 pending files are mixed with four already assigned audio masters: two in an album named `wav`, and two in `Unknown Album`. They span positions 1–29 with gaps caused by those four already-assigned rows, so the pending cohort alone is not a complete album identity.

The B directory is an independent 16-track edition: `01 清澜若雪-Narrator Version-`, `02 信号心桥`, `03 深秋之霜`, `04 卡珊德拉症候群`, `05 Sublimity`, `06 答案不唯一`, `07 答案不唯一-Mobile Version-`, `08 Cassandra`, `09 进化算法`, `10 致邀请老用户`, `11 献给黑色圣母的檄文`, `12 月白非白`, `13 处决一束白月光`, `14 沉没海妖之礁`, `15 刀风刃雨`, `16 系统万象`. The A edition has eight numbered positions with two established anchors and two bonus tracks; the B list has a different sequence and version-specific tracks. Keep A and B separate as two albums; a later presentation-layer release should place them in a shared display group. The shared root has separate `coverA.jpg` and `coverB.jpg` sidecars. No audio or sidecar objects are modified by the candidate. PCM equivalence was not asserted from titles or etags.

## Fresh primary evidence

The A directory primary SELECT returned eight WAV instances under exact parent `se-698bb4fd7be549aaa70de23aa64ae9a1`. Pending masters are positions 1, 2, 5, 6, 7, 8. Existing album `al-86f72c214f` is named `矩尺镜海·蚀刻于此媒介A`; its same-artist anchor masters are position 3 `系统万象` and position 4 `致邀请老用户`. All eight rows have physical `objects/*.wav` keys and source `r2-local`. The A target album currently has 2 masters, stored duration 0, and size 70,560,088; summing its masters gives duration 400 and size 70,560,088. The six pending files sum to 1,140 seconds and 201,096,264 bytes. A successful archive should produce target caches of 8 / 1,540 seconds / 271,656,352 bytes with tracks 1–8 unique. The fresh pending cache snapshot is 581 / 129,701 / 22,611,646,437 and agrees with live aggregates; after six rows move it should be 575 / 128,561 / 22,410,550,173.

The album and A cohort query results were served by D1 primary with `rows_written=0` and `changed_db=false`. This audit does not write production.

## Guard requirements

The SQL candidate compares each of six source rows using NULL-safe checks, including master identity/title/duration/untagged album and track state, instance source/URI/suffix/duration/size/missing/tag scan/object/etag, entry id/source/parent/path/display/kind/object/companion, and object physical key/suffix/size/legacy key/etag. It also guards both existing A anchor rows and exact target album and pending cache state. The CUE and audio object rows are never deleted or changed.

## Verification

Fresh primary preflight at the recorded audit pass returned all six expected source rows and target/cache aggregates, with `served_by_primary=true`, `rows_written=0`, and `changed_db=false`. The local Wrangler rehearsal passed all three scenes: successful assignment/recalculation; stale physical-key change rejected without candidate writes; and forced final-statement failure atomically rolled back candidate writes while preserving the marker row.
