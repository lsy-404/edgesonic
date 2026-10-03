# Progress

- Confirmed requested worktree was clean and unused, then created `codex/album-listening-queries` from `eb7078e`.
- Read the required agent-mode and Cloudflare skills, project index, task registry, and local instructions.
- Inspected `listAlbums`, `scrobbleSong`, endpoint annotation mapping, schema, and existing album list filter tests.
- Changed `listAlbums` to aggregate all users' song play counts and latest play dates by album, and use those values for frequent/recent selection and ordering.
- Added `test/helpers/albumListeningDb.ts` backed by the full production schema plus `test/subsonic/album_listening.test.ts` with real SQLite behavior coverage.
- Passed `npx tsx test/subsonic/album_listening.test.ts`, `album_list_filters.test.ts`, `annotation.test.ts`, `top_songs_local.test.ts`, and `npm run typecheck -w worker`.
- Committed as `fix: rank album lists from song listening history` on the isolated task branch.
- Follow-up: gated the cross-song aggregation CTE and join to `frequent`/`recent`, preserving album-annotation metadata and list ordering for all other types; compressed the SQL rationale comment to one sentence.
- Follow-up verification passed: `npx tsx test/subsonic/album_listening.test.ts`, `npx tsx test/subsonic/album_list_filters.test.ts`, and `npm run typecheck -w worker`.

- 根集成真实浏览器音频与 production Hono+完整 schema SQLite 联调通过：开始空榜，歌曲达到实际收听门槛后写入，当前首页立即更新，两次同曲提高热度、最近顺序独立，预载不计数、暂停不重复、刷新读取持久记录、503 不阻断播放且不更新榜单、禁用注释权限不上报。
- Added `test/subsonic/album_listening_auth.test.ts` using the full schema fixture, real `authMiddleware`, and mounted Subsonic routes; verified t+s/p credentials, repeatable ids/times, submission behavior, auth failures, and returned frequent/recent album order.
