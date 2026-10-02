# 工作计划
- [x] 加载项目工作流与规则，核对隔离 worktree 和基线。
- [x] 追踪重解析、上传/扫描、专辑身份、标签写入和前端字段路径。
- [x] 在 tag/read 为缺失专辑艺人的普通既有专辑保留已存 album artist identity。
- [x] 在根 test 下为 ID3 重扫添加 SQLite 回归，覆盖 track artist 更新且 album identity 不漂移。
- [x] 运行定向回归与 worker typecheck，检查 diff；准备提交隔离分支。

- [x] 修正 metadata worker 的 scan identity，使自定义/人工合并 album ID 在扫描等价专辑名时保持。
- [x] 两条解析入口覆盖引号、空白、NFD、不同专辑名和不同 album artist；验证音频版本与 compilation 既有断言。