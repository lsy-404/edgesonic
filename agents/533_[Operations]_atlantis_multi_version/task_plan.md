# Atlantis 多版显示归组与 SV6 审计计划

## 范围

保留 production 中所有当前 live masters、实例、标签和对象；将 WAV、书名号 FLAC 和独立的非括号 FLAC 第 3 轨按版本建专辑，并在展示层归组。对 pending 中 `『亚特兰蒂斯Atlantis』/sv重置版` 的 6 个 MP3 做只读证据审计。生产保持只读。

## 步骤

- [x] 收集历史 Atlantis PCM、标签和上次生产回执。
- [x] 使用已确认的 production Wrangler config 刷新 primary 专辑/曲目/对象/引用/归组快照；所有查询 `rows_written=0`，并检查数据库完整性。
- [x] 审计 pending SV6 的来源、标签和曲序证据；证据不足，保持 pending。
- [x] 以精确快照守卫演练 D1 SQL 的成功、过期快照拒绝、末段失败完整回滚；核对完整 JSON 尾部。
- [x] 保存候选、审计材料和本地回执；不执行 production 写入。
- [x] 使用最终快照重建候选，并重新通过本地成功、stale guard 和 late failure 回滚演练。
- [x] 记录生产操作员提供的 guarded apply SHA、primary postflight、存储完整性与 pending/cache 状态；不重跑候选。
- [x] 仅提交本任务目录和本任务 `/test` 文件；自检提交范围。
