# 进度

- 已完成启动检查，读取 agent-mode、项目索引、任务记录及 Subsonic/SSO 审计。
- 已确认当前分支已包含上一轮专用 Subsonic 凭据边界修复。
- 已加入共享身份映射开关、环境声明、wrangler 示例和精确 identity_accounts.id 查询。
- 已在 OIDC 集成测试中覆盖默认关闭、开关开启、inactive callback 和幂等写入；既有 activation_enforcement 与 sso_modes 测试继续覆盖受限路由及 required Subsonic 凭据。
- 聚焦测试 5/5、完整 `test:sso` 4/4、Worker typecheck、web typecheck 和 `git diff --check` 全部通过。
- 未部署、未推送、未合并；已创建普通 commit。
- 已修复共享映射写入后的并发竞争窗口，并用测试 hook 模拟竞争映射，确认最终 session 采用持久化赢家。
- amend 前最终验证：OIDC 测试通过、完整 `test:sso` 4/4、Worker typecheck、web typecheck 和 `git diff --check` 全部通过。
- 已在生产配置开启同库映射并部署版本 `01dc128e-6768-4d91-a630-a5823771e9dd`。
- 已完成生产首次映射、未激活门禁、撤权及清理验证；另行回归专用密码、token+salt 与 API key，三种 Subsonic `/rest/ping.view` 均为 200/`ok`。
- 最终生产配置复核：SSO 为 required 且可用、activation 开启、访客关闭、本地注册和本地登录均为 403。
