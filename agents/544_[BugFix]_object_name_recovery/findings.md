# 调查记录

## 已确认

- `applyMetadataResult` 与 `/tag/read` 对 `r2://objects/obj_<hash>.<suffix>` 调用路径元数据恢复，标题会被恢复成 `obj_<hash>`，根目录会被恢复成专辑 `objects`。
- `storage_entries` 保存人类可读逻辑路径，且每个条目通过 `instance_id` 关联音频实例；仅存在唯一文件路径时才适合作为恢复依据。
- Subsonic mapper 也会调用中央恢复函数，但缺少 `storage_entries` 查询上下文；中央函数应拒绝 `objects/` 物理前缀，避免在展示时泄漏对象编号。
- 旧 R2 迁移会将旧 key 传作逻辑路径。本任务最小改动聚焦标签恢复调用与恢复守卫，避免进一步产生错误元数据；不访问或修改生产数据。

## 设计

- 增加按 `instance_id` 唯一读取文件 entry path 的 helper；零条或多条都返回 `null`。
- 两个标签解析入口仅在有唯一逻辑路径时从该路径恢复；无路径时保留解析结果，不回退到 storage URI。
- 中央恢复函数识别并拒绝 `objects/` 路径；清洁的已有元数据继续优先保留。
## 实施更新

- 已按唯一 entry 路径接入 `metadataApply` 和 `/tag/read`；两处均不再从 `song_instances.storage_uri` 推断元数据。
- 中央恢复仍供 Subsonic mapper 使用，但会拒绝 R2 的 `objects/` 命名空间和裸稳定对象文件名。
- `migrate-r2` 会在有现存关联 entry 时复用其路径，使本次迁移不再另建旧 key 名称的 entry。
- 没有唯一逻辑路径时不补造元数据；未知曲目保留原标签或既有值。

## 验证记录

- 首次运行新增测试时，tsx 将脚本按 CJS 转换并拒绝顶层 await；将异步断言放入 `main()` 后解决。
- `npx tsx test/internal/object_name_recovery.test.ts`：12 项断言通过。
- `npx tsx test/internal/legacy_tag_charset_recovery.test.ts`：9 项断言通过，已有路径恢复和 Subsonic 映射行为未回归。
- `npm run typecheck -w worker`：通过。
- `git diff --check`：通过。

## 复核修正

- 复核物理键后确认 ID 长度可能为 16、24 或 32 位；保护正则扩展到 16–64 位十六进制，并增加 24/32 位嵌套路径用例。
- 项目级 `agents/project.md` 与 `agents/tasks.md` 不纳入任务提交，避免覆盖主工作区未跟踪的同名索引。
- 修正后新增回归 12 项、既有标签恢复测试 9 项、Worker typecheck 与 diff-check 全部通过。
