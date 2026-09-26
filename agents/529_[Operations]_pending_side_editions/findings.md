# 调研记录

## 生产只读审计

查询由 primary 提供，未写入数据。Chromatic 的目录名在 `Chromatic` 与 `Harmony` 之间含不换行空格；普通空格的路径筛选不会命中。

`异色合鸣Chromatic Harmony（wav）/A盘` 和 `B盘` 各有 12 个待处理 WAV。现有 FLAC 专辑 `al-9c7ec22ef5` 有 24 个曲目和相同的 A/B 内容范围。WAV 的曲名和时长并非逐项相同；后续完整 R2 PCM 收据证明 24 对音源全部不同，因此必须保留独立 WAV masters、标题、实例、对象和目录项，不能用 FLAC 元数据覆盖 WAV。

彩胶根目录的 `SIDE A` 有 5 首、`SIDE B` 有 6 首，构成一张 11 首彩胶版。根目录同时有独立的 6 首 `夏日应时而至-CD版`，其中部分曲名重叠；它们不是本候选的一部分。根目录封面为 `夏日应时而至 (彩胶板)/cover.jpg`，对象 `obj_8e193f74e0f392d5`。

彩胶执行前的待处理专辑缓存与主从实际聚合均为 677 首、149831 秒、26394169003 字节。

彩胶候选用完整的 master、instance、object、entry、逻辑路径和物理键快照约束 11 个文件；fresh primary 预检仍为目标冲突 0、待处理且无曲序的源行 11。末段使用生产 `work_queue.status` 的 CHECK 约束作为失败守卫。

## 生产回执

候选 SHA-256 为 `58334c3daf90d36aeeb65993327fe10df68f77fb8946668bc1f2484c41b89528`。Wrangler 在 primary 上成功执行四条语句并写入 27 行。彩胶专辑有 11 首、2422 秒和 547679176 字节；disc 1 为轨 1--5，disc 2 为轨 1--6。11 个 instance、object 和 entry 均保持原身份。同根 CD 的六首仍在待处理专辑。

独立 primary 后验显示待处理专辑为 641 首、141395 秒和 24700222725 字节；彩胶与待处理专辑的缓存均与实际聚合相符。

## Chromatic WAV 双版分组

- 对生产 R2 中 A 盘和 B 盘的 24 对 WAV/FLAC 分别解码为 signed 32-bit little-endian PCM。24 对的 PCM 字节数与 SHA-256 全部不同，因此两版都必须保留为独立音频。
- Fresh primary SELECT-only 快照精确命中 24 个 WAV，A、B 各 12 首。守卫包含 master、当前 pending album、原 title/duration/track/disc、instance、suffix、size、object、physical key、entry、parent 和完整路径；包含 NBSP 的根目录名按精确值匹配。
- 现有 FLAC album `al-9c7ec22ef5` 的缓存与实际行聚合一致：24 首、5171 秒、1166586233 字节。候选会把此状态作为前置守卫，不修正 FLAC 缓存。
- 此分支执行期间，协调任务先归档 8 首、随后又归档 28 首 WAV。pending 专辑由 641 首降为 605 首；归档 28 首后的 fresh primary SELECT-only 检查中 pending 缓存与实际均为 605 首、134913 秒、23531408853 字节。候选以归组后的实际 `song_masters` 和 `song_instances` 聚合刷新 pending 与新 WAV 专辑缓存，不依赖这个可变化的全局 pending 基线。
- 新 WAV 专辑只更改 24 个 master 的 `album_id`、`disc`、`track` 和更新时间；保留 title/duration、音频实例、对象、物理键、entry 与路径。A/B 映射为 disc 1/2，各自 track 1--12。
- Wrangler local 成功、source snapshot 过期、最终 CHECK 失败三种演练均通过；后两种确认整批回滚。没有在本分支向生产写入数据。
