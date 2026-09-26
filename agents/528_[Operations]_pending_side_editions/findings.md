# 调研记录

## 生产只读审计

查询由 primary 提供，未写入数据。Chromatic 的目录名在 `Chromatic` 与 `Harmony` 之间含不换行空格；普通空格的路径筛选不会命中。

`异色合鸣Chromatic Harmony（wav）/A盘` 和 `B盘` 各有 12 个待处理 WAV。现有 FLAC 专辑 `al-9c7ec22ef5` 有 24 个曲目和相同的 A/B 内容范围。WAV 的曲名和时长并非逐项相同，且仓库没有这 24 对的完整 PCM 解码收据。因此音频差异尚未证明；归组时必须保留独立 WAV masters、标题、实例、对象和目录项，不能用 FLAC 元数据覆盖 WAV。

彩胶根目录的 `SIDE A` 有 5 首、`SIDE B` 有 6 首，构成一张 11 首彩胶版。根目录同时有独立的 6 首 `夏日应时而至-CD版`，其中部分曲名重叠；它们不是本候选的一部分。根目录封面为 `夏日应时而至 (彩胶板)/cover.jpg`，对象 `obj_8e193f74e0f392d5`。

待处理专辑缓存与主从实际聚合均为 677 首、149831 秒、26394169003 字节。

彩胶候选用完整的 master、instance、object、entry、逻辑路径和物理键快照约束 11 个文件；fresh primary 预检仍为目标冲突 0、待处理且无曲序的源行 11。末段使用生产 `work_queue.status` 的 CHECK 约束作为失败守卫。
