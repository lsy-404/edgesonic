# 调研记录

- [现象] Library 的 `ListOptionsMenu` 通过 `Teleport to="body"` 渲染 `FluentSwitch`。
  -> [核查] FluentSwitch 使用 `--fluent-accent`、`--fluent-control`、`--fluent-border` 等变量，并以 `.fluent-switch--checked` 和 `aria-checked` 表示选中。
  -> [根因] Teleport 后菜单不再是 `FluentTheme` 的后代，组件包的主题 token 不会继承；滑道背景、边框和选中态颜色因此可能解析为空。
- [方案] 在列表菜单自身设置来自 EdgeSonic 主题变量的 Fluent token，让现有 checked class/ARIA 状态正常可见；不改全局 `fluent.css`，不触碰 StarButton。
