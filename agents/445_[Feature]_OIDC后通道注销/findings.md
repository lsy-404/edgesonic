# Findings

## 范围与删除边界

- endpoint 为 `POST /edgesonic/auth/sso/backchannel-logout`，不要求浏览器 auth。
- 只读取有界 `application/x-www-form-urlencoded` 请求体；必须存在且只能有一个 `logout_token`，未知字段忽略。
- 使用当前 `SSO_ISSUER`、`SSO_CLIENT_ID` 的 discovery/JWKS；仅接受 `typ=logout+jwt`、`alg=RS256`，并验证可信 issuer、audience、iat 新鲜度、exp、jti、events、sub，拒绝 nonce。
- 根据 `oidc_identities(issuer, subject)` 精确取得 username；只执行 `DELETE FROM sessions`，条件为 `username`、`auth_source='sso'`、`sso_issuer` 和 `sso_client_id` 全部匹配。
- 不读取个人 SSO 权限表，不使用 sid；重复有效通知没有目标行时仍返回 200。

## 协议不受影响

- 删除逻辑只作用于 SSO Web sessions，不删除 local sessions。
- `subsonic_credentials`、Subsonic token+salt、`api_keys`、`guest_tokens` 均不参与删除，因此不会被后通道注销影响。

## 验证与提交

- `npm run typecheck -w worker` 通过。
- `npx tsx test/internal/backchannel_logout.test.ts` 通过：匿名 endpoint、幂等 200、无效 token 400、未知字段、重复 token、精确 session 删除及非 SSO 凭据保留。
- `npm run test:sso` 通过，4 个既有 SSO 回归测试全部通过。
- Wrangler dry-run 通过，未部署。
- 实现 commit `4860a22`；其后审阅与审计追加提交强制 `typ=logout+jwt` 并覆盖错误 typ、错误 issuer、错误签名。
