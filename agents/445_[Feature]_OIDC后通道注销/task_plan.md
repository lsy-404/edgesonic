# OIDC 后通道注销

- [x] 检查 EdgeSonic 当前最大任务号、Git 状态、worktree 与 remote
- [x] 创建独立 worktree 与分支并建立 agent-mode 审计
- [x] 复用当前配置 issuer discovery/JWKS，验证 RS256 logout token
- [x] 实现有界表单 endpoint、精确 SSO session 删除与幂等响应
- [x] 保持 Subsonic token+salt、plain dedicated credential、OpenSubsonic apiKey、guest 不受影响
- [x] 增加标准字段、错误 typ/issuer/签名及凭据边界测试
- [x] 完成类型检查、SSO 回归测试和 Wrangler dry-run
- [x] 提交实现与 typ/负例追加 commit
