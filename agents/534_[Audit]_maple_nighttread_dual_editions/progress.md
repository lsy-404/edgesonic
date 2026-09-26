# Progress

- [x] 从当前 origin/main 派生 `codex/maple-nighttread-editions`，复用现有 managed worktree。
- [x] primary source tuple 20/20；R2 文件大小 20/20；PCM pair SHA-256 10/10 不同。
- [x] 生成 guarded apply SQL 与 primary SELECT-only preflight。
- [x] primary cache 最新为 522 / 116545 / 20262441225，且与聚合一致；albums/group conflicts=0。
- [x] Wrangler local 成功、stale path、concurrent title mutation、late overflow 四种演练通过。三个失败场景的完整相关表指纹保持一致。
- [x] 写入测试回执和 SQL SHA；未执行 production 写入。
- [x] 仅本任务目录与 `/test` 已暂存；核对 staged path 无用户文件或其他任务文件。

- 复核 sidecar：生产 primary SELECT 查询 `companion_of` 与 object 元数据，逐个下载两张 JPEG 并比较 SHA-256/尺寸；没有更改 D1/R2。
- 审核 album display group 与 cover 维护实现，确认 canonical per-album keys 可避开共享 key 清理和 sidecar 前缀清理。
- 修改 `artifacts/apply_guarded.sql`：加入两 sidecar 精确 guard，设置两个不同 canonical cover key 和末尾 key invariant。更新 SELECT-only preflight、local seed/fingerprint/演练。
- Wrangler local 演练 PASS：成功指纹 `9EAD6483EA2527C33683BA4BD8E130F0B7ECFEA94C67581D7964F59AEDFD5942`；sidecar stale、source stale、concurrent、late failure rollback 均为 true。
- Production preflight 使用独立 `wrangler d1 execute ... --command` 纯 SELECT，fresh source tuple 20/20、sidecar 2/2、pending/cache 与冲突为预期；所有命令均 primary、rows_written=0、changed_db=false。未执行生产写入。
- `--file` 聚合查询一度给出 changed_db=true/changes=1 与 rows_written=0 不一致；改用短 `--command` 精确复核后，主库读取证据无上述矛盾。

- 提交前以 Wrangler remote object GET 对两个 canonical cover key 再做只读检查，结果均为不存在；未执行 PUT/DELETE。记录第一个 GET 返回 404 后 Wrangler Windows 端异常退出的工具行为。

- 本任务续接记录父任务已执行的 production 回执：两个 canonical R2 cover 对象复制后读回且 SHA/size 与根 cover 一致；精确 D1 候选成功，source 20/20、sidecar 2/2。
- 独立 postflight 确认两版 album/实例/对象/entry/tag scan/cache、显示组成员次序、pending 聚合、sidecar 完整性；quick_check 与 foreign_key_check 均通过。所有 postflight 为 primary read-only。
- 复跑 Wrangler local rehearsal PASS：successFingerprint `9EAD6483EA2527C33683BA4BD8E130F0B7ECFEA94C67581D7964F59AEDFD5942`；sidecar stale、path stale、concurrent、late failure 回滚均 true。
