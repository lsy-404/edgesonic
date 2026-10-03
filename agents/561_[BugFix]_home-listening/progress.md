# 进度
- 2026-10-02：以 main 77363c8 为基线，复用 clean worktree；主目录存在无关用户改动，保持隔离。

- 根集成真实浏览器音频与 production Hono+完整 schema SQLite 联调通过：开始空榜，歌曲达到实际收听门槛后写入，当前首页立即更新，两次同曲提高热度、最近顺序独立，预载不计数、暂停不重复、刷新读取持久记录、503 不阻断播放且不更新榜单、禁用注释权限不上报。

- npm run typecheck（worker/web/installer）、web build、album_listening、annotation、album_list_filters、top_songs_local、player_listening_progress、home_music_data、player_restore_progress、player_resilience、player_range_lifecycle、player_queue_dismiss 全部通过。
- 浏览器执行：NODE_PATH 指向捆绑 Playwright node_modules，npx tsx test/frontend/home_listening_browser.mts；使用 msedge headless 与隔离本地服务，截图在 ignored test/artifacts/home-listening。
