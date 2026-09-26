# 操作记录

- 创建了隔离工作树和 `codex/pending-side-editions` 分支。
- 使用远端 Wrangler 对 production primary 执行只读 D1 审计；所有查询的 rows_written 均为零。
- 发现 Chromatic 根名使用不换行空格，并核对了两个待处理版与同根 CD 版的物理目录范围。
- 写入彩胶候选并以 fresh primary 只读预检再次确认全部 11 条源身份及目标空位。
- Wrangler 本地夹具验证了成功、过期快照和末段失败均符合候选约束与原子回滚预期。
- 生产候选已由协调任务执行；记录了独立 primary 后验和缓存重算结果。
- 从生产 R2 读取 Chromatic 首对并完成独立 PCM 解码；收据不外推到其余曲目。

- 创建并维护隔离工作树 `codex/pending-side-editions`；主工作区保持不动。
- 复用 production R2 PCM 收据，确认全部 24 对 Chromatic WAV/FLAC 的解码 PCM 哈希和字节数不同。
- 对 production primary 执行 SELECT-only fresh preflight，保存 24 行完整 WAV 源快照、pending/FLAC 聚合与冲突计数。协调任务归档另外 28 首后重新预检；24 行快照未变、目标冲突仍为 0，pending 缓存与实际均为 605 首 / 134913 秒 / 23531408853 字节。所有查询写入计数为 0，primary 路由为真。
- 生成 `apply_chromatic_wav_guarded.sql`：对 24 行身份及 FLAC 的 24 首 / 5171 秒 / 1166586233 字节缓存加前置守卫；建立独立 WAV album 和显示组；保留标题、时长和所有音频/目录身份；按本地实际聚合重算 pending/WAV 缓存。
- 新增 Wrangler 本地 fixture 和 rehearsal，真实 Wrangler local 批次验证成功、过期快照回滚、最后一条 CHECK 失败回滚。
- 未在本分支对 production 执行写入。候选与演练完成，等待协调任务决定集中执行时间。
