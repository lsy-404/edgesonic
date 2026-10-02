# 调研
- 主目录存在用户其他工作，所有实现使用隔离 worktree。
- Fluent0.2.5 提供按钮、字段、选择器等，但没有 Expander/Accordion 导出；折叠卡使用现有主题令牌与原生语义组件。
- stats/library 读取已有 cached row，返回 ready/stale；不能把全库计数用到搜索、伴奏过滤或分组卡片。
- Ultrasonic 官方页面已在 GitLab，避免使用历史 GitHub 迁移仓库作为官网。
- 浏览器实际截图发现 Icon 默认内联 1em 与 SVG padding 相互挤压；分类图标改为固定容器中的 18px SVG，展开箭头明确尺寸，避免修改共享图标组件。
- 自动加载只读复核发现续载期间移除旧结果、搜索 ref 反复重建 observer、失败后分页被卡住；实现分支修正后由延迟请求和 503 fixture 做行为验证。
- 集成失败注入识别到现存列表将非协议 503 正文当空页：不应置 EOF 或缩减总页数；追加页请求必须验证有效 Subsonic 响应，并复验显式重试。
