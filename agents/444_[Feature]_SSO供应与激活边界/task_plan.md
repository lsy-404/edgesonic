# 实施计划

## 范围

- [x] 核对现有显式 OIDC 映射、激活状态与 required Subsonic 边界。
- [x] 增加默认关闭的同库精确 subject 映射开关。
- [x] 为环境类型、wrangler 示例和 OIDC 回调补充契约测试。
- [x] 证明新映射保留激活状态、建立受限 session，并阻止未激活业务路由。
- [x] 运行聚焦测试、完整 SSO 测试及 Worker/web typecheck。
- [x] 检查 diff，创建普通 commit；不部署、不推送、不合并。

## 验收

- [x] 显式 oidc_identities 映射优先。
- [x] 默认关闭时不会按 identity_accounts 自动映射。
- [x] 开关开启时只按 identity_accounts.id 精确映射且幂等。
- [x] OIDC callback 保留 activation_status/activated_until 并返回 inactive 状态。
- [x] 非激活接口被后端拒绝，activation 接口仍可用。
- [x] required 模式下专用 Subsonic 凭据仍可用。
