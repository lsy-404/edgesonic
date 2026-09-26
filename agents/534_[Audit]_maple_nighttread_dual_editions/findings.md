# Findings: 枫烬-夜屠灵 双版归档

## Primary 快照与内容核验

- 精确 storage-entry path 前缀 `枫烬-夜屠灵/` 命中 20 个原始 master：WAV 10、MP3 10；各版本曲序 01–10。
- primary SELECT-only 核验 20/20 行的 master、instance、object、entry、父目录、路径、physical key、来源、title、duration、字节数和缺失/tag 状态。回执在 `artifacts/snapshot.json` 与 `artifacts/primary_preflight_receipt.json`。
- 全部 R2 文件通过 Wrangler 下载，20/20 对象的文件长度符合 primary `storage_objects.size`。
- 无同名专辑、预定 WAV/MP3 album ID 或 display group 冲突。

## PCM 与元数据结论

- 所有配对双声道；采样率为 44.1 kHz（01–07、10）或 48 kHz（08–09）；同曲时长一致。数据库时长依次为 216、240、222、211、243、284、247、243、224、226 秒。
- WAV 为 16-bit 或 24-bit PCM；MP3 为有损编码。FFmpeg 解码到 signed 32-bit little-endian PCM 后，10 组 SHA-256 全部不同。codec、rate、时长、字节数与 hashes 见 `artifacts/pcm_receipt.json`。
- 按保留双方的规则，将创建单独 WAV 与 MP3 专辑，并以一个 display group 归组。候选保持原 title、duration、R2 objects、instances、entries 和路径，只更新 master 的 album、disc、track。

## 最新 pending/cache 预检

- 最新 primary 快照：pending 实际/缓存均为 522 首、116545 秒、20262441225 字节；source 守卫 20/20；album/group 冲突均为 0。
- 四条 SELECT 均由 primary 处理，`changed_db=false` 且 `rows_written=0`。
- WAV album cache：10 / 2356 / 572036956；MP3 album cache：10 / 2356 / 94355582。
- pending 写入后重算为 502 / 111833 / 19596048687。
- 先前 pending=539 与 523 的只读结果均被并发归档推进。候选更新为最新 522 快照；若执行前状态再变化，前置守卫会中止。

## 候选与测试

- `artifacts/apply_guarded.sql` 精确比较 20 行源 tuple；保护 pending 全局缓存和 album/group 冲突。成功后重算全部三个 album cache，并校验归属、曲序、专辑缓存与 group 成员。每个阶段和末尾均有失败中止语句。
- 以 Wrangler local 对全新小型 D1 seed 演练成功、path 过期、master title 并发变化、末段 integer overflow。stale、concurrent 与 late failure 场景的完整相关表指纹前后相同；结果见 `artifacts/test_rehearsal_receipt.json`。
- 未写 production。
- apply SQL SHA-256：`D8C5D9C81D6B4733B59B94D1C0CF66838BE4215090B351C138B4BA45774F48BC`。
