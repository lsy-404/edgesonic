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
