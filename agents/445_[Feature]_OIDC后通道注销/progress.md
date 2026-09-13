# Progress

- 已确认 EdgeSonic 当前最大任务号为 444，并登记本任务 445。
- 已在 `/Users/user/.codex/worktrees/edgesonic/backchannel-logout` 创建独立分支 `codex/backchannel-logout`；实现仅修改 EdgeSonic。
- 已完成 OIDC Back-Channel Logout RP endpoint，并提交 `4860a22`。
- 按审阅要求追加 `typ=logout+jwt` 强校验与错误 typ、错误 issuer、错误签名测试，并与审计文件合并提交。
- 已完成类型检查、定向测试、完整 SSO 回归测试和 Wrangler dry-run；未部署。
- 当前分支 head 已复核，Git worktree 状态干净。
- Codex 将分支快进合并到 main 并推送 `origin/main`；主线再次通过类型检查、定向测试、4 个 SSO 回归测试和实际生产配置 dry-run。
- 已部署 EdgeSonic Worker，版本 `8ca5abaf-d967-4639-9363-f58c9ea8c597`，部署标记为 `20260912-sso-backchannel`。
- 生产伪造 logout token 返回 400；真实管理员 deny 后，匹配的 SSO session 变为 401，同用户 local session、Subsonic credential 和 API key 均保留。
- 部署后再次用随机 active user 验证 dedicated plain、token+salt、OpenSubsonic API key，三条 `/rest/ping.view` 均返回 `status=ok`；测试用户、credential 与 key 清理为 0。
