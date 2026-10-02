# 工作计划
- [x] 加载项目工作流与规则，核对隔离 worktree 和基线。
- [x] 追踪重解析、上传/扫描、专辑身份、标签写入和前端字段路径。
- [x] 在 tag/read 为缺失专辑艺人的普通既有专辑保留已存 album artist identity。
- [x] 在根 test 下为 ID3 重扫添加 SQLite 回归，覆盖 track artist 更新且 album identity 不漂移。
- [x] 运行定向回归与 worker typecheck，检查 diff；准备提交隔离分支。

- [x] 修正 metadata worker 的 scan identity，使自定义/人工合并 album ID 在扫描等价专辑名时保持。
- [x] 两条解析入口覆盖引号、空白、NFD、不同专辑名和不同 album artist；验证音频版本与 compilation 既有断言。
- [x] 读取album.duration消费者并计算快照中的song_count/duration/size聚合差异。
- [x] 修复metadataApply和tag/read扫描聚合duration；覆盖duration-only解析、真实tag/read SQLite route和迁移旧album。
- [x] 生成完整只读目录检查CSV/JSON及21个R2对象ffprobe与hash/ETag证据。
- [x] 验证route回归、worker typecheck、diff check并准备提交。
- [ ] Investigate the metadata executor duration output gate with real local fixtures and cached audit samples.
- [ ] Correct cross-format duration emission while retaining guarded partial-MP3 and fragmented-MP4 behavior.
- [ ] Identify the invalid WAV payload from magic bytes and available local cache/source evidence; do not transform it.
- [ ] Run focused parser and route tests, worker/web typechecks, and commit the parser fix separately.

- [x] Investigate the metadata executor duration output gate with real local fixtures and cached audit samples.
- [x] Correct duration retention for full-file MP4 reads and MP4 signature/MIME mismatches without implementing a container parser.
- [x] Identify the invalid WAV payload from magic bytes and available local cache/source evidence; do not transform it.
- [x] Run focused parser and route tests, worker/web typechecks, and commit the parser fix separately.
