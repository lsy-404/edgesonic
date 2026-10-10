# EdgeSonic 项目索引
> 最后更新：2026-09-26

## 项目目标
在 Cloudflare 上运行音乐文件管理与播放服务，保持 R2 文件、D1 索引和媒体标签一致。

## 技术栈
- Cloudflare Workers、R2、D1
- TypeScript、Vue、Node.js
- Wrangler 负责远端资源操作

## 模块结构
- `worker/`：API、数据库迁移和后台工作。
- `web/`：文件浏览器与媒体库界面。
- `scripts/`：独立维护工具。
- `test/`：项目测试。
- `agents/`：任务审计与操作记录。

## 项目约束
- 项目级补充指令见 [local.instructions.md](local.instructions.md)。
- 线上文件操作须先形成可核对清单、备份与回滚方案。

## Recent tools
- Work Mode offers selectable parsing, transcode, metadata retrieval and lossless compression tasks. WAV-to-FLAC compression uses the existing browser FFmpeg engine, verifies decoded audio and metadata, then atomically updates the original file references; library compression is explicitly queued.

- Work Mode can explicitly restart retrieval for missing metadata, uses configured provider adapters, preserves existing catalog fields and release identity, and recovers interrupted catalog application.
