# 操作记录

- 2026-10-02：检查目标 worktree 干净状态及 worktree 列表，从 `eb7078e` 创建 `codex/player-listening-report`；主目录未改动。
- 2026-10-02：新增 `ListeningProgress` 进度状态机和 Home revision 通知；播放器接入活动音频时间、权限校验与 best-effort scrobble；Home 对成功播放记录刷新 frequent/recent。
- 2026-10-02：`npx tsx test/frontend/player_listening_progress.test.ts` 通过；`npm run typecheck -w web` 通过；`npm run build -w web` 通过。构建仅显示现有外部化和 chunk size 提示。
- 2026-10-02：等待根任务进行真实浏览器端到端验证；本分支不推送、不部署。
- 2026-10-02：集成审查发现共享 `catalogId` 用于收藏/getSong，恢复其既有返回语义；将非目录流过滤限定在 listening report，并将活动元素与 track ID 绑定以防切换事件错记。补充外部流/文件 track ID 行为断言。

- 根集成真实浏览器音频与 production Hono+完整 schema SQLite 联调通过：开始空榜，歌曲达到实际收听门槛后写入，当前首页立即更新，两次同曲提高热度、最近顺序独立，预载不计数、暂停不重复、刷新读取持久记录、503 不阻断播放且不更新榜单、禁用注释权限不上报。
