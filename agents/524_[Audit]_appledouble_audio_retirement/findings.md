# Findings

- 两个对象均为 176 bytes，首四字节为 `00 05 16 07`（AppleDouble magic），随后为版本 `00 02 00 00` 和 `Mac OS X`；WAV 必需的 `RIFF`/`WAVE` 标识不存在。
- 主库复核显示它们各自只关联一个 master、一个 original instance 和一个文件树叶节点。没有子实例、转码、歌单、标注或歌曲艺术家引用；两个 metadata 队列项均已完成。
- `r2-local` 的完整扫描会仅在存在 instance 为空的 file storage entry 时为稳定对象重新登记。候选同时删除两个叶节点，因此保留的对象不会被重新导入。
- 候选不删除 R2 字节、不删除 `storage_objects`，也不删除完成队列记录；后两者保留为恢复证据。
- 生产字段按原样保留为 mojibake；候选不会重命名或修复源文件名。
- 每个关键删除后用现有 `storage_entries` 的 `CHECK` 约束验证 `changes()`；任何未完整命中都失败并由 D1 文件执行事务回滚。
