# 核验结论

生产主库快照显示 `al-1a27548730` 有九首 FLAC，路径位于 `平行四界Quadimension 3/`；`平四1-6/平行四界3/` 有九首待处理 WAV。两侧时长和曲序对应，但历史逐轨解码报告确认 WAV/FLAC 为 0/9 相同 PCM，因此必须保留两版。

候选只会把九个既有 WAV master 归入新 WAV 专辑、复制既有 FLAC 的曲目元数据和 artist credits，并建立一个两成员展示组。不会创建、删除或替换任何音频对象、实例或文件目录项。

候选文件 SHA-256 为 `4f90557a8de08db720bd1c5dd1d139d09f3e434f49bf04d2b044fd2c3abfb4b9`。WAV master 保留原有 duration；新 WAV 专辑复制 FLAC 专辑封面。候选末段从实际 song_masters 和 song_instances 重算新 WAV 专辑与 Pending Uploads 的 `song_count`、`duration`、`size`，随后验证两张专辑的缓存字段与实际行一致。真实 Wrangler 本地文件执行完成了成功、源路径过期和末段唯一约束失败三个场景：成功场景得到 9 首 WAV、9 首 FLAC 和两个展示成员；两个失败场景均保持 9 首 WAV 在 Pending Uploads 且未留下展示组。

最终生产主库只读前置检查：FLAC master/path 为 9/9，待处理 WAV/path 为 9/9，WAV 当前总时长为 2334 秒、实例总大小为 411729756 字节，FLAC 专辑封面为 `covers/al-1a27548730`，目标专辑和展示组都尚不存在。请求未写入数据库。

生产执行完成后，独立 primary 后验确认新 WAV 专辑有九首曲目、disc 1 的 track 1–9、2334 秒和 411729756 字节；原 FLAC 专辑仍有九首、2334 秒和 302480640 字节。展示组包含两个成员，FLAC 的排序为 0、WAV 的排序为 1。九个 WAV 的实例、对象、目录项和路径均保持原值。Pending Uploads 的三项缓存和实际聚合都为 677 首、149831 秒、26394169003 字节。
