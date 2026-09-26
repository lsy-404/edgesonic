# 调研发现

## 版次边界

- 历史 `agents/455_[Operations]_重复专辑与品质合并` 的 PCM 回执证明 WAV 与书名号括号 FLAC 8/8 轨 PCM 不同；应保留为两个完整版本。
- WAV 与非括号根目录 FLAC 的 1、2、4–8 轨 PCM 相同，第 3 轨 PCM 不同。现存 live 数据只有根目录 FLAC 第 3 轨，故它应作为单轨 alternate mix 版保留；不得以曾存在过的七个 PCM 重复轨为依据重建实例。
- `exact51_old_r2_delete_state.json` 记录前述七个非括号 FLAC 对象在既有 WAV 优先规则下已退役，含备份哈希与 `deleted:true`；本次只读 primary/R2 检查亦确认这些对象没有 D1 storage object/entry 且 R2 key 已不存在。本候选不复活、不删除或搬动对象。

## 当前数据库快照

- 最终生产 primary 刷新显示 `al-eddee4ba83`（亚特兰蒂斯，2018）仍有 17 个 masters/instances：WAV 8、书名号 FLAC 8、非括号 FLAC 第 3 轨 1；音源分别有对象和路径，missing=0。相册没有现存 display group；封面键 `covers/al-eddee4ba83` 可读。
- 精确候选快照逐项固定 master、instance、object、storage entry、曲序、时长、大小、tag 扫描状态、标题和路径；还固定源专辑元数据、引用数、16 条 WAV clone map、group/member ID 尚不存在。`build_candidate.py` 只从成功的 primary read（`served_by_primary=true`, `rows_written=0`）生成 SQL。
- SV 重置版 6 个 MP3 当前都属于共享 `pending-uploads`，音轨/碟号为空、artist 为 unknown-artist，文件名不能建立可靠次序。旧 disposition 中记录的 album id 已不存在。故不把共享 pending 中的文件移动或分组；SV6 继续 pending。

## 候选和演练

- 候选保留现有 WAV 专辑为 WAV 版；新建书名号 FLAC 8 轨版和非括号 track 3 alternate mix 单轨版，三者以“亚特兰蒂斯 Atlantis”组成一个显示组。
- 只改 master 的 album_id 与 album 聚合字段，并写入 group/member；原始 master ID、实例、标签、storage object、entry、路径、封面键以及 clone map 都保留。
- Wrangler 本地 D1 完整演练通过：正常应用后 3 个 group members 对应 8/8/1 masters 且 17 objects/entries、16 clone rows 全部保留；人为改动快照后候选拒绝且状态不变；在成功 SQL 末尾注入重复 membership 约束失败，整个变更回滚，源专辑、17 masters/objects/entries、16 clone rows 均恢复。
- Wrangler 每步退出状态与完整 JSON 输出尾部保存于 `local_wrangler_rehearsal_receipt.json`。这不是生产应用回执。

## 生产限制

- 最终刷新通过主 checkout 提供的已确认 production Wrangler 配置执行，仅运行 D1 `--remote` 查询；每项快照与引用查询均由 primary 服务，`rows_written=0`。快照、相册、归组和引用回执已更新，完整性查询返回 `quick_check=ok` 且 `foreign_key_check` 无结果。
- 生产操作员已执行受 exact guard 保护的候选，SHA-256 `65EE5AC1CA37FA0A5DD8151BC42F5DE9F634D14AC1F7C859BD4DA0EADB5C3C4E`，primary 返回 exit 0。此审计提交仅记录操作员提供的执行/postflight 回执，不重跑候选。
- 操作顺序说明：操作员当时意图运行只读文件，却选择并执行了 apply 候选；完整 primary guard 通过后候选写入，随后独立 postflight 全部通过。该顺序失误已向用户透明说明。
- Postflight primary 回读确认展示组名“亚特兰蒂斯 Atlantis”，顺序为 WAV 版 (8/1883/334673646)、书名号 FLAC 版 (8/1883/214326468)、非括号 track 3 mix (1/257/30408791)。17/17 instances、entries、objects 完整，missing=0，covers 保留，相关活动队列和 guard marker 均为 0。
- Pending 状态未变，count/duration/size 为 522/116545/20262441225，actual 与 cache 一致。完整性检查 `quick_check=ok`、`foreign_key_check` 为空，所有 postflight 回读来自 primary 且 `rows_written=0`。详细执行摘要见 `production_apply_receipt.json`。
