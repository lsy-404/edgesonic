# 595 Access authority 与 Connector

## 仓库与边界

- 起始代码基于 `origin/main` (`ef58ce7b73638a46e632c7d958991ae4822410dd`)；主工作区有既有未提交/未跟踪内容，未触碰。
- 工作树 `C:/Users/User/.codex/worktrees/edgesonic/access-authority`，分支 `feat/access-authority`，工作树内仅审计文件改动。
- 未访问 Cloudflare 生产配置、未部署、未输出凭据。

## 调查结论

### 登录、注册与激活

- `worker/src/utils/ssoPolicy.ts` 的 `SSO_MODE=required` 禁止本地认证；保留这一入口策略，不因 Access 改造重新开放密码登录或注册。
- `worker/src/endpoints/edgesonic/auth.ts` 的 `loginConfig` 还要求 `open_registration` 且邮件或 activation gate 有配置；注册 POST 又实际执行该配置检查、邀请码/邮箱 gate。此处是本地注册策略，不应混同于 SSO Access 授权。
- SSO OIDC callback 在 `worker/src/utils/oidc.ts` 只接受启用且 `level >= 1` 的既有本地用户。`resolveIdentity` 接收 ID token 和 userinfo 但忽略两者；身份通过 `(issuer, subject)` 映射到 `users.username`。启用 `SSO_SHARED_IDENTITY_MAPPING=1` 时可通过 `identity_accounts.id = subject` 找已存在本地账户并建立映射；没有按 email 接管或自动创建用户的逻辑。
- `worker/src/auth.ts` 在 API 路由前执行 activation freeze：无效激活状态可拒绝 API key/Subsonic credential，并冻结网页session（激活API及`/auth/me`例外；访客开启时仅允许降级的只读路径）。session滑动续期被激活窗口夹断。
- `worker/src/endpoints/edgesonic/auth.ts` 登录发session时按 activation clamp TTL；新建Subsonic credential时按activation写 `expires_at`。KTV房间所有者检查也单独读取activation状态。

### 权限和ownership

- 权限键定义在 `worker/src/utils/permissions.ts`。与常见服务profile直接相关的可执行权限为 `stream`, `browse`, `search`, `download`, `upload`, `share`, `manage_playlists`, `manage_podcasts`, `manage_radio`, `edit_tags`, `edit_annotations`。
- 本地权限由 `users.level` 对应的 `user_permissions` 以及本地 `PERMISSIONS_OVERRIDE` 控制。level 3 在权限辅助函数中无条件获得全权限；`manage_permissions` 始终硬编码为 `user.level === 3`。level 0/1 还有读取时 hardlock。level不应来自Connector角色写回共享的`users`表。
- `shares`按`username`所有权查询，播放列表和媒体编辑也有本地用户作用域。OIDC grant只能改变此EdgeSonic会话的服务权限，不得更改username、ownership、数据归属或跨用户可见性。

### SCIM与服务配置

- 在 `worker/src`、路由入口和本地测试中未找到SCIM endpoint或handler；当前没有SCIM契约可与Access冲突。
- 没发现已消费的OIDC roles claim；`test/internal/oidc_flow.test.ts`虽有角色字段的测试token，但用户权限取自本地DB，不证明线上有role映射。

## Connector建议

- 使用专用ACCESS service binding；服务端对固定client `edgesonic-personal`查每账号grant。浏览器使用已验证subject，原生凭据在认证后使用本地username；禁止按email映射账户。
- Connector回复typed `serviceIdentity: listener | member | creator`决定业务profile；`serviceConfig.permissions`是11项业务权限的部分布尔覆盖，只允许false收窄profile，不能由任意JSON授予其它权限。unknown/missing identity拒绝。
- 这些profile都不包含 `manage_users`, `manage_permissions`, `manage_settings`, `manage_sources`, `maintenance_*`, `manage_activation`, `view_all_users_items`, `manage_cloudflare`。任何服务admin概念只可定义为EdgeSonic本地运行时作用域，不得转换为共享`users.level=3`。
- 本地activation是重复准入门：任何认证方式在凭据验证后取得当前Access grant，即免除activation freeze和旧activation TTL夹断；每个请求、session续期与OIDC callback/refresh重新校验grant，session不能超过grant expiry。无grant且非required无binding模式仍执行旧activation规则。
- API key与Subsonic credential先按原密码/签名和记录存在性验证，再按username查询Access；`expires_at`只代表旧activation horizon，不代表独立凭据生命周期。凭据删除仍撤销；Access拒绝立即阻断。
- 已采用确定契约：Access grant决定11项profile业务permission，不与旧permission矩阵做AND；本地矩阵、level、owner与管理员边界对非profile能力继续生效。

## 验证

- Windows本机、worktree依赖安装后运行 `pnpm run test:sso`：4/4通过（`oidc_flow`, `sso_modes`, `login_sso_behavior`, `personal_sso_mapping`），exit code 0，耗时约1.15s。
- Node发出SQLite experimental warning；OIDC负例测试会打印预期callback failure诊断，但全部断言通过。
- 调查阶段的初始SSO基线通过；后续实现验证见“最终验证”。

## 实现与最终契约

- 新增 `worker/src/utils/accessAuthority.ts`：调用专用`ACCESS` binding的`POST https://access.internal/authorize`，仅按`subject`或`username`其一提交；拒绝错误HTTP、拒绝grant、过期expiry、未知identity、未知config字段和错误permission类型。`expiresAt: null`表示grant无固定期限，session仍受EdgeSonic的7天窗口和每请求recheck约束。
- `serviceIdentity`严格限制为`listener | member | creator`：listener=`stream,browse,search`；member再含`download,upload,share,manage_playlists,manage_podcasts,manage_radio`；creator再含`edit_tags,edit_annotations`。`serviceConfig.permissions`只能false收窄profile；true不能扩权，未知key失败关闭。
- 经确认的Access授权在每个受保护请求上重新验证：浏览器OIDC会话使用`session.sso_issuer + oidc_identities.subject`；API key、Subsonic credential及本地cookie身份验证后使用`username`。SSO callback/refresh也重新查Access，session到期取Access到期与7天窗口的较早值。required mode无binding或无授权返回拒绝；service绑定在测试/本地可选模式缺失时沿旧本地路径运行。
- 对已获Access grant的身份，不再让`activation_status`和由activation派生的session/credential expiry重复挡准入；Access grant按请求生效、过期/撤销立即拒绝。没有grant时本地/activation旧规则仍工作。`users.level`和`user_permissions`不写入；`manage_permissions`、跨用户/所有权、sources管理和管理员边界继续由本地授权控制。
- `subsonic_credentials.expires_at`唯一写入链为`credentialExpiryFor(resolveActivation())`和按用户`restampCredentials()`，表示activation horizon，没有独立per-credential expiry入口；access认证先验证凭据密码/签名，再由当前Access决定，删除凭据记录仍撤销。测试覆盖过期activation派生expiry+有效grant可用、grant拒绝、删除凭据仍401。
- `worker/src/endpoints/storage/files.ts`原本level2前置门会重复挡住`upload` profile。仅上传/目录创建/移动/复制等已有`permissionMiddleware('upload')`的精确路由允许Access upload通过；删除仍需local level2和原`delete`权限，source管理仍需local `manage_sources`及level2。owner/key/path校验保持不变。
- Guest在有binding或required mode下也以`username='guest'`调用Access；required缺binding失败，connector public policy无明确guest assignment时拒绝。Guest level0 hardlock仍只允许stream/browse/search；guest delegation token记录仍需存在。无binding的非required部署保留本地Guest行为。
- 新增`worker/wrangler.toml.example`的注释式`ACCESS` service binding配置示例；实际部署binding和生产配置未触碰。

## 最终验证

- `pnpm run test:sso`：4/4通过，含真实OIDC回调按subject获批/拒绝、无expiry session窗口、inactive local activation可通过授权。
- `pnpm exec tsx --test test/internal/access_authority.test.ts test/internal/auth_cookie_session.test.ts test/internal/auth_session_boundary.test.ts test/internal/authentication.test.ts test/internal/authorization.test.ts test/internal/email_auth_flow.test.ts`：6/6文件通过。
- `pnpm exec tsx --test test/internal/files_mkdir.test.ts test/internal/files_folder_ops.test.ts test/internal/files_delete.test.ts`：3/3文件通过。
- `pnpm run typecheck`：worker、web、installer全部通过。
