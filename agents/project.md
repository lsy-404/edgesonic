# EdgeSonic 项目索引
> 最后更新：2026-09-12

## 项目目标

EdgeSonic 是运行在 Cloudflare Workers 上的 Subsonic 兼容音乐库与管理界面，提供浏览、播放、搜索、文件管理、歌单、收藏、分享及媒体元数据维护能力。

## 技术栈

- 前端：Vue 3、Vite、Pinia、Vue Router、vue-i18n、TypeScript
- 后端：Cloudflare Workers、Hono、D1、R2、TypeScript
- 仓库结构：`web/` 前端 SPA，`worker/` Worker/API，`test/` 自包含测试脚本

## 本次任务相关约束

- 生产实例只允许通过个人身份中心登录。
- 身份映射必须保留现有用户名、等级、数据与业务权限。
- 必须阻止旧 Web 密码、注册和密码重置接口绕过强制 SSO。
- 登录页在强制模式下自动跳转，并避免失败回跳形成重定向循环。

