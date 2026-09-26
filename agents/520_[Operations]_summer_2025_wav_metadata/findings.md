# 核验与决定

2025 夏浪派对的 `ONE SELF` FLAC 与 `14 ONE SEIF` WAV 有相同 PCM 前缀，但 WAV 多出 588 个非零双声道采样帧，属于应保留的不同音频版本。显示组已上线，两个音轨的标题和 R2 对象各自保留。

上线后页面的 WAV 版本显示 `Unknown Artist`。主库只读核验显示 WAV master 的 `artist_id=unknown-artist`、`genre=NULL`、`lyrics=NULL` 且无 `song_artists`；对应 FLAC master 有洛天依、`VOCALOID`、542 字歌词及一条主演唱者关系。两轨都为第 14 首且时长 108 秒。

只复制非标题元数据；WAV 标题继续保持 `14 ONE SEIF`，FLAC 标题继续保持 `ONE SELF`。不改动 `song_instances`、`storage_entries`、`storage_objects` 或 R2。歌词字段更新会由现有数据库触发器加入搜索索引待处理表。

## 执行结果

生产主库只读前检 `guard_failed=0`、`rows_written=0`。第一次 Wrangler 导入请求遇到 Cloudflare 身份验证错误；主库随后确认原记录未变化。CLI 的只读查询成功后重试相同 SQL，退出码 0，主库记录 `rows_written=7`。候选 SHA-256 为 `b6364cf22f778fa25eb520dd43b7e5323fe5ffdd82b664ba56f4ab598c8cf083`。

生产主库只读后检：WAV 音轨仍为独立 master、track 14、原 instance 和文件条目；演唱者为洛天依，风格 `VOCALOID`，歌词长度 542，主演唱者关系 1 条，歌词索引待处理标记 1 条，展示组成员仍为 2 个。已登录页面刷新后 WAV 版本由 `Unknown Artist` 改为洛天依，两版本仍独立显示。
