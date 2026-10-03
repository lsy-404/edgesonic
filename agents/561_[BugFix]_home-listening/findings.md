# 调研
- 网页 player 未调用 scrobble。
- scrobbleSong 只写 song annotations；listAlbums frequent/recent 过滤 album annotations，因此历史歌曲记录不进入榜单。

- 直接端点联调不经过生产认证，认证用测试用户上下文注入；生产查询、权限端点、XML、歌曲记录与首页消费保留真实代码。音频为 6s 本地内存 WAV，无线上/第三方调用。
- 测试初始 .ts 顶层 await 在根 CommonJS 输出失败，改为 .mts 明确 ESM 后运行通过。
- 全库歌曲聚合 CTE 限制 frequent/recent，避免普通 newest/alphabetical 浏览扫描所有播放记录。
- 用户明确要求 Subsonic 客户端共用记录链路：持久化只在服务端 /rest/scrobble 写入 song annotations，网页播放器作为同一接口消费者；补充实际 authMiddleware 客户端密码验证。
