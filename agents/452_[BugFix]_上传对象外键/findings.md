# 调研记录

- [上传新 R2 音频返回 D1 外键错误] -> 检查 `files.ts` 与 `0037_r2_d1_storage_objects.sql` -> `song_instances.storage_object_id` 引用 `storage_objects(id)`，而新实例批量写入发生在 `registerR2Object` 创建对象之前。
- [覆盖已有 R2 音频的风险] -> 检查目标解析逻辑 -> 覆盖也会分配新的稳定对象 ID，因此更新实例前也必须先创建对应存储对象。
- [回归测试和类型检查无法启动] -> 在新 worktree 运行测试命令 -> worktree 尚未安装依赖，缺少 `hono`、`tsx` 和 `tsc`；先安装锁定依赖后重试。
- [首次外键回归失败] -> 检查测试替身 -> 替身并行执行 D1 batch，且错误地将 WebDAV 的空对象 ID 当作外键；D1 batch 应按语句顺序执行，已让替身串行执行并仅校验非空对象 ID。
- [最终验证] -> 运行上传回归测试和 Worker 类型检查 -> 两项均通过。
- [签名提交失败] -> 使用仓库默认 SSH 签名提交 -> 本机 1Password 签名代理返回错误；改用一次性的无签名提交，代码和测试不受影响。
