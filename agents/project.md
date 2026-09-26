# EdgeSonic 项目索引

> 最后更新：2026-09-26

## 项目目标

在 Cloudflare 上运行音乐文件管理与播放服务，保持 R2 文件、D1 索引和媒体标签一致。

## 技术栈

- Cloudflare Workers、R2、D1
- TypeScript、Vue、Node.js

## 模块结构

- `worker/`：API、数据库迁移和后台工作。
- `web/`：文件浏览器与媒体库界面。
- `scripts/`：独立维护工具。
- `test/`：项目测试。
- `agents/`：任务审计与操作记录。
