# Progress

- 已读取 agent-mode、Cloudflare 与 Workers best-practices技能、项目约束；保留脏主工作区，从`origin/main`建独立`feat/access-authority` worktree。
- 已完成注册/激活、OIDC共享身份映射、本地permission matrix、ownership与SCIM检索；没有改业务源码。
- 已向root报告Connector契约及business profile建议，并按root最终契约实现Access准入、typed permissions、activation覆盖、credential与Guest行为。
- 初始`pnpm run test:sso`基线4/4通过；最终脚本覆盖Access helper后8/8通过。

## 实现进度

- 已按root确认的service binding契约实现runtime授权和typed permission profile，覆盖浏览器subject、原生credential username、required无binding、grant拒绝/过期/无expiry、activation bypass、session期限、Guest显式grant、Access文件上传权限、credentials撤销等行为。
- 已为permission helper、OIDC flow、SSO modes更新/新增测试，并跑相关auth、permission、upload/delete测试及全仓typecheck。
- `pnpm run typecheck`、SSO/auth、permission、file/upload相关测试均通过；未部署、未修改生产binding、未推送。独立提交：`fac8ebb7bb86a5e63efa0d3d2f01a06b49c9cb49`。

- Integrated production ID-center schema/code and deployed EdgeSonic as d899fb6f-b922-4375-ae4c-e2e7d385927b; ACCESS service binding points to personal-sso#EdgeSonicAccessConnector.
- Real production smoke used an ordinary freshly registered account, deliberately disabled its legacy activation, assigned creator/download=false in ACCESS and completed the actual EdgeSonic OIDC login. /edgesonic/auth/me confirmed level 1, active admission, upload/edit_tags enabled, download disabled and manage_users disabled. Setting the service assignment to deny then rejected the already established session.
- Removed all temporary verification accounts, client metadata and grants; account/policy/assignment counts returned to baseline. Kept original primary tracked/untracked state intact; only appended the intended ACCESS binding to its ignored deployment config for future deploys.
- The primary main checkout contains unrelated dirty audit/work files, so source delivery uses an independent clean main checkout and leaves that primary branch/worktree untouched.
