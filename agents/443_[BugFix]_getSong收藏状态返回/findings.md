# 调研记录

- [问题现象] `getSong` 被报告没有返回歌曲是否已收藏 -> [代码检查] 路由会按当前用户名查询 `annotations` 并把结果传给 `mapSong` -> [结论] 需要端点级测试覆盖真实 XML 响应，并继续确认哪些注解数据形态会导致字段缺失。
- [现有契约] Web 播放器读取 `<song starred="...">` 的存在性作为布尔收藏状态 -> [结论] 修复应保持 Subsonic 的时间戳字段语义，不能返回字符串 `false`。
- [测试环境] 在新 worktree 直接运行 `npx tsx` -> [失败原因] worktree 未安装依赖，临时 npx 环境无法解析 `hono` -> [处理] 后续测试复用主 checkout 已安装的依赖，不改锁文件。
- [回归复现] 端点级测试写入 `starred = 1, starred_at = NULL` 后调用 `getSong` -> [结果] 响应没有 `starred` 属性，测试按预期失败 -> [根因] `applyAnnotation` 同时要求收藏标记为 1 且时间非空，错误地把时间缺失等同于未收藏。
- [修复方案] 收藏布尔状态以 `starred` 列为准 -> [实现] 有真实时间时原样返回 ISO 时间；旧数据缺时间时返回 Unix epoch ISO 作为稳定哨兵，仍保持 Subsonic 的可选时间戳字段类型。
- [验证] annotation 端点套件与 OpenSubsonic 映射套件全部通过；Worker `tsc --noEmit` 通过 -> [结论] 修复覆盖真实 XML、取消收藏、用户隔离与现有映射契约。
- [类型检查环境] 仅设置 `NODE_PATH` 运行 `tsc` -> [失败原因] TypeScript 不从 `NODE_PATH` 解析声明包 -> [处理] 临时链接主 checkout 的 `node_modules` 后检查通过，并在命令结束时自动移除链接。
