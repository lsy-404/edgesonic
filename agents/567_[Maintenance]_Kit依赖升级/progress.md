# 操作记录

- 2026-10-07：git fetch origin；检查 worktree list；创建独立工作树。

- 更新 installer/package.json, web/package.json 中当前使用的公共 kit 依赖。

- 2026-10-07：安装、实际版本核对及受影响检查通过；main 未保护、无适用 ruleset；交付前再次 fetch，远端未变化。

- 推送到 origin/main：b42436ab127f2d6bf52b800ab264ad5aa448a9c9；fetch 确认远端指向相同提交。

- 2026-10-07：所有使用的已发布包归档都具有真实 SHA-512；pnpm install --frozen-lockfile --ignore-scripts 通过（npm 项目使用真实更新后的 package-lock）。
