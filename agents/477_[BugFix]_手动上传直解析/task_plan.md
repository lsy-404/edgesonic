# 手动上传直解析并发与恢复补强计划

- [x] 复核 WIP 与审计记录，确认原 AGENTS.md 在开发区路径不存在并遵守当前会话提供的规则。
- [x] 修复封面候选对象写入后的 CAS 竞态清理与 preserved 状态准确性，并覆盖测试。
- [x] 将每次上传随机代号持久化到恢复标记并纳入 token subject，防止同 URI 覆盖令牌重放。
- [x] 仅在恢复队列已核实为当前 URI 的任务后消费标记；陈旧 queued/claimed 任务不能被当作已恢复。
- [x] 为浏览器关闭恢复、陈旧队列状态和同 URI 旧 token 添加测试。
- [x] 完成定向测试、类型检查、web build 和 diff 复核；本地 amendment 交付。

## Adversarial follow-up
- [x] Reject queued metadata results unless their source URI and upload generation match the current instance and marker; preserve legacy behavior when no generation marker exists.
- [x] Reject upload-only audio overwrite whenever the resolved physical target exists, even without a D1 instance row.
- [x] Add claimed-before-overwrite submission and WebDAV stale-D1 overwrite tests; remove global agents index files from this branch.
- [x] Rerun focused tests, typecheck, web build, inspect staged diff, and amend the branch commit.
