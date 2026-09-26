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
- 候选准备阶段未写 production；根任务后续执行回执见本文件末尾。
- apply SQL SHA-256：`2CEF2C10F6460EAEBC06545ABFFFEA517AEEB9DFA5B94AAC53FF1DBFC1272E88`。

## Sidecar 封面与版本归属

- 两条封面 storage entry 均为 `instance_id=NULL`、`companion_of=NULL`。根目录 cover 的 parent 是 `枫烬-夜屠灵` 目录；歌词封面的 parent 是其子目录 `枫烬-夜屠灵/歌词`。两者的 storage object、physical key、大小与字节内容均不同。R2 下载内容 SHA-256 分别为 `887A4E...B37796`（1728×1080）与 `9DF202...93E62`（1080×1080）。
- 根封面处于 WAV/MP3 文件夹共同父级，作为两版共用素材有路径依据；歌词封面仅属于歌词子目录，没有证据把它归给其中一个音频版。
- display group schema 没有 group cover 字段；每个 album 单独带 `cover_r2_key`，组详情按 album 分别返回 cover。`resolveAlbumCover` 仅回填内嵌音频封面；目录图像 fallback 已移除。
- `normalizeCoverKeys` 会复制非 canonical key 到 `covers/<albumId>` 后删除旧 key 前缀；直接把 album 指向 sidecar 的 `objects/...jpg` 会让存储条目引用对象被后续维护清除。`cleanupDuplicateCovers` 也会清空共享同一 key 的一个专辑封面。
- 候选为 WAV 与 MP3 分别使用 `covers/al-maple-nighttread-wav`、`covers/al-maple-nighttread-mp3`。这两个 R2 key 在最近只读 list 时都不存在；必须在任何 D1 apply 前，将根封面的相同 bytes 单独复制到两个 canonical key，并校验 SHA-256。若 apply 前目标已存在但内容不同，停止复核。原始两个 `objects/...jpg` sidecar 都保留，不做覆盖或删除。候选准备阶段未执行 R2 copy；根任务后续按该流程写入并读取校验，详见生产回执。
- apply 的前置强守卫现在精确要求两个 sidecar 的 entry/object/parent/path/name/kind/instance/companion/physical-key/MIME/size 快照；local seed 对 sidecar 物理键变化进行了失败与整库指纹回滚验证。最终校验也要求两个 album 指向各自 canonical cover key。
- fresh primary source guard 以 5 条分片的纯 SELECT `--command` 检查全部 20 行，五组均 expected=4/exact=4/unique=4；sidecar exact=2。pending cache/actual 为 522/116545/20262441225，album/group 冲突均为 0，所有命令均 primary、`changed_db=false`、`rows_written=0`。
- 单文件 `--file` 的 Wrangler 汇总曾显示 `changed_db=true/changes=1`，但 `rows_written=0`。最终 preflight 改用独立纯 SELECT `--command`，结果均 `changed_db=false/changes=0`；文件模式汇总不作为最终 preflight 证据。
- 扩展 Wrangler local 演练通过：成功、sidecar 物理键过期、音频 path 过期、master title 并发改变、末段 integer overflow。四种失败后的完整相关表指纹均保持不变。

- Commit 前再次对两个完整 canonical key 执行 Wrangler remote object GET（只读），均明确返回 key does not exist；本轮无 R2 写操作。一个 GET 在返回 404 后触发 Wrangler Windows 进程断言并异常退出，第二个以标准错误码退出，但两者对象结果都是不存在。

## Production 执行回执

- 根任务将根目录原图 `objects/obj_1b4a15b85d0840f4.jpg`（128,995 bytes，SHA-256 `887A4E95410C92BAC1098442241D0265AB907D1EAD51C78A27E0C48DD8B37796`）分别复制至 `covers/al-maple-nighttread-wav` 与 `covers/al-maple-nighttread-mp3`；两个对象均读回且长度/hash 与源一致。原始 sidecar 保持完整。
- 根任务使用 candidate SHA `2CEF2C10F6460EAEBC06545ABFFFEA517AEEB9DFA5B94AAC53FF1DBFC1272E88` 执行 Wrangler remote `--command`，exit 0、served_by_primary=true。执行前 source guard 20/20、sidecar guard 2/2，pending snapshot 522/116545/20262441225。
- 独立 postflight：WAV album 10/2356/572036956，instances/objects/entries 各 10，全部 tag_scanned，cover key canonical；MP3 album 10/2356/94355582，同样各 10 且全部扫描，cover key canonical。组 `ag-maple-nighttread-editions` 名称为 `枫烬-夜屠灵`，顺序 WAV sort_order=0、MP3=1。
- pending cache 与聚合一致，为 502/111833/19596048687；两个原始 sidecar entry/key/metadata 完整。所有 postflight 查询均 primary、changed_db=false、rows_written=0；`quick_check=ok`、`foreign_key_check` 为空。
- 因十组 decoded PCM 均不同，按用户规则保留 WAV 与 MP3 两版。此生产步骤由根任务执行，本回执编辑没有进行生产访问。
