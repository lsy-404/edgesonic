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

## Sidecar 封面与版本归属

- 两条封面 storage entry 均为 `instance_id=NULL`、`companion_of=NULL`。根目录 cover 的 parent 是 `枫烬-夜屠灵` 目录；歌词封面的 parent 是其子目录 `枫烬-夜屠灵/歌词`。两者的 storage object、physical key、大小与字节内容均不同。R2 下载内容 SHA-256 分别为 `887A4E...B37796`（1728×1080）与 `9DF202...93E62`（1080×1080）。
- 根封面处于 WAV/MP3 文件夹共同父级，作为两版共用素材有路径依据；歌词封面仅属于歌词子目录，没有证据把它归给其中一个音频版。
- display group schema 没有 group cover 字段；每个 album 单独带 `cover_r2_key`，组详情按 album 分别返回 cover。`resolveAlbumCover` 仅回填内嵌音频封面；目录图像 fallback 已移除。
- `normalizeCoverKeys` 会复制非 canonical key 到 `covers/<albumId>` 后删除旧 key 前缀；直接把 album 指向 sidecar 的 `objects/...jpg` 会让存储条目引用对象被后续维护清除。`cleanupDuplicateCovers` 也会清空共享同一 key 的一个专辑封面。
- 候选为 WAV 与 MP3 分别使用 `covers/al-maple-nighttread-wav`、`covers/al-maple-nighttread-mp3`。这两个 R2 key 在最近只读 list 时都不存在；必须在任何 D1 apply 前，将根封面的相同 bytes 单独复制到两个 canonical key，并校验 SHA-256。若 apply 前目标已存在但内容不同，停止复核。原始两个 `objects/...jpg` sidecar 都保留，不做覆盖或删除。R2 copy 不在此次 SQL/local D1 演练范围，本轮没有执行 R2 写入。
- apply 的前置强守卫现在精确要求两个 sidecar 的 entry/object/parent/path/name/kind/instance/companion/physical-key/MIME/size 快照；local seed 对 sidecar 物理键变化进行了失败与整库指纹回滚验证。最终校验也要求两个 album 指向各自 canonical cover key。
- fresh primary source guard 以 5 条分片的纯 SELECT `--command` 检查全部 20 行，五组均 expected=4/exact=4/unique=4；sidecar exact=2。pending cache/actual 为 522/116545/20262441225，album/group 冲突均为 0，所有命令均 primary、`changed_db=false`、`rows_written=0`。
- 单文件 `--file` 的 Wrangler 汇总曾显示 `changed_db=true/changes=1`，但 `rows_written=0`。最终 preflight 改用独立纯 SELECT `--command`，结果均 `changed_db=false/changes=0`；文件模式汇总不作为最终 preflight 证据。
- 扩展 Wrangler local 演练通过：成功、sidecar 物理键过期、音频 path 过期、master title 并发改变、末段 integer overflow。四种失败后的完整相关表指纹均保持不变。
