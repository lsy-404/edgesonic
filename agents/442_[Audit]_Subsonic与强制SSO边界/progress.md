# 进度

- 已完成启动检查、项目索引和既有任务记录阅读。
- 已创建本审计任务记录，尚未修改业务代码。
- 已审计 `worker/src/auth.ts`：确认 required 原逻辑误拒绝非 session 的 Subsonic/API key 认证。
- 已修改认证边界，并更新 `test/internal/sso_modes.test.ts` 覆盖专用 `u+p`、`u+t+s`、API key。
- 聚焦测试通过：`sso_modes`、`apikey_auth`、`subsonic_master_password_rejection`。
- `npm run test:sso` 通过，4 个 SSO 测试文件全部通过；OIDC 测试输出的 token_grant/identity_mapping 错误为故意覆盖的失败场景。
- `npm run typecheck -w worker` 通过。
- 已从 `worker/` 完成 Wrangler dry-run 与生产部署；当前部署版本为 `00bf112d-074a-4629-b45f-720609fdf7f5`。
- 已完成生产协议回归：专用密码、token+salt 与 API key 三种 `/rest/ping.view` 路径均通过，合成数据清理检查为 0。
- 已复核 required Web 边界：本地登录 403，SSO 可用，注册与本地密码重置保持关闭。
