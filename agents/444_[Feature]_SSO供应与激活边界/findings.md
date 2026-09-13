# 调研记录

## 证据

- `resolveIdentity` 先查询 `oidc_identities`，因此显式映射可以保持最高优先级。
- OIDC 回调已经从 `users` 读取 `activation_status` 和 `activated_until`，并用 `resolveActivation` 计算 session TTL 与返回状态。
- `authMiddleware` 已对 inactive session 保留 activation/me 与 auth/me，同时阻断普通管理和受保护 REST 路由。
- required 模式下专用 `subsonic_cred`、`apikey`、`guest` 已被上一轮边界修复放行；本任务只补回归，不改变该策略。

## 决策

- 共享映射开关命名为 `SSO_SHARED_IDENTITY_MAPPING`，只有精确值 `"1"` 开启，默认关闭。
- 映射只使用 OIDC token 的 `sub` 查询 `identity_accounts.id`，不读取或比较 email/username 作为猜测键。
- 复用现有 users 行，不创建 Personal SSO 新表或合成 EdgeSonic 用户。
- 共享候选写入后必须重新读取 `oidc_identities`；若并发回调先持久化了显式或其他最终映射，当前 session 必须使用数据库赢家。
