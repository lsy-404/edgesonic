# 调研记录

## 初始假设

- 需要区分浏览器 Web 会话策略与 Subsonic 客户端在 `/rest/*` 使用的独立认证材料。
- 现有生产用户数据、凭据和秘密不得读取到输出或测试文件。

## 证据

- `worker/src/auth.ts` 将认证方法区分为 `session`、`subsonic_cred`、`apikey`、`guest`；`/rest/*` 的 `u+p` 只查 `subsonic_credentials`，`u+t+s` 查同一表，`apiKey` 查 `api_keys`。
- required 策略原先在认证成功后对所有非 `session` 方法返回 `SSO authentication is required`，因此会把 API key 与专用 Subsonic credential 错误地变成 403。
- 管理路径另有 `isMgmt` 与 `REST_SESSION_ONLY_PATHS` 保护；Web 管理面仍应要求 cookie session，且 required 模式下该 session 必须来自 SSO。
- 项目已有测试 `test/internal/sso_modes.test.ts` 将 required + API key 断言为 403；该断言与目标协议兼容性相冲突，已改为覆盖成功认证，并新增专用 credential 的密码和 token+salt 路径。

## 决定

- 仅放行已成功验证的 `subsonic_cred`、`apikey`、`guest` 到 required 模式的 `/rest/*` 继续执行；不放行本地 Web session。
- `u+p` 使用主 Web 密码且没有专用 Subsonic credential 时仍由既有防误用逻辑拒绝；这是凭据类型边界，不是 SSO 造成的破坏。

## 验证结果

- `npx tsx --test test/internal/sso_modes.test.ts test/opensubsonic/apikey_auth.test.ts test/internal/subsonic_master_password_rejection.test.ts`：3/3 通过。
- `npm run test:sso`：4/4 通过。
- `npm run typecheck -w worker`：通过。
- 全部测试使用内存数据库和合成凭据字符串，未读取、输出或写入任何现有用户凭据或秘密。
