# 发现

生产 primary 快照确认起程转合目录含七个 WAV、一个 cover.jpg 文件条目。七首各有一个原始实例、一个稳定 R2 对象和一个文件条目；没有 annotations、bookmarks、playlist_songs、share_entries、scrape_jobs 或 transcode_jobs 引用。封面对象只由该目录引用，物理键为 `objects/obj_52c5c2fbd8c092f8.jpg`。

六首仍在 `pending-uploads`，第三首位于 `al-3ff61cef3d`。该混杂专辑其余 39 首来自多个不同父目录，包括三月雨、百变绫绫、月光入侵计划等，未纳入本候选。

候选只插入专辑 `al-qichengzhuanhe-wav`，把七个既有 master 改至该专辑并设置曲序一至七，然后从当前 masters/instances 重算三个受影响专辑的歌曲数、时长和大小。它不写 instances、storage_entries、storage_objects、R2 或音频标签。封面字段使用 R2 物理键。

本地 Wrangler D1 fixture 完成成功、过期守卫和 rollback 三种演练。最后一次 primary 预检显示七个精确 source/path/object 条件均成立，目标 album 不存在；pending 为 692 个 master、`al-3ff61cef3d` 为 40 个 master。该候选将这些当前计数和聚合值写入守卫，任一变化均不会写入。
