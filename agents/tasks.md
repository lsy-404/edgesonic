# EdgeSonic 任务追踪
> 准则版本: v0.2.2

| 编号 | 任务名称 | 任务描述 | 变更动机 | 状态 |
| :--: | :------: | :------: | :------: | :--: |
| 549 | [Feature] Library Fluent navigation | 媒体库分页、Fluent 依赖与查看器、设置工具布局、客户端独立页面 | 用户要求修复导航与布局 | ✅ 已完成 |
| 550 | [Feature] Library pagination | 媒体库列表与搜索分页、可选页大小、服务端分页上限 | 用户要求选择页长与页间切换 | ✅ 已完成 |
| 551 | [Feature] Client navigation | 客户端独立页面、设置与工具布局 | 明确客户端指引与管理入口 | ✅ 已完成 |
| 552 | [Feature] Viewer Fluent | Fluent 升级与查看器布局 | 改善主题与响应式显示 | ✅ 已完成 |
| 556 | [Feature] Library modes and management interface | 集成分页/自动加载、可用总页数、客户端精简及默认折叠官网链接、设置工具折叠卡重设计 | 用户要求后续界面调整 | ✅ 已完成 |
| 557 | [Feature] Library load modes | 媒体库分页与自动加载切换，依据真实已知信息显示总页数，覆盖过滤/搜索/收藏/分组及异步取消 | 用户要求后续界面调整 | ✅ 已完成 |
| 558 | [Feature] Client simplification | 侧栏客户端简称，去掉权限等冗余描述，创建客户端密码，精简连接表单与默认折叠客户端官网链接 | 用户要求后续界面调整 | ✅ 已完成 |
| 559 | [Feature] Management expanders | 重设计设置与工具的一二级折叠卡，使用现有 Fluent API/主题，改善键盘语义与响应式 | 用户要求后续界面调整 | ✅ 已完成 |
| 561 | [BugFix] home-listening | 首页热门与最近专辑播放链路集成验证 | 用户报告首页两个播放榜单不工作 | ✅ 已完成 |
| 562 | [BugFix] album-listening-queries | 从实际歌曲播放记录派生专辑热门和最近排序 | 用户报告首页两个播放榜单不工作 | ✅ 已完成 |
| 563 | [BugFix] player-listening-report | 播放器提交实际收听记录并刷新首页播放榜单 | 用户报告首页两个播放榜单不工作 | ✅ 已完成 |
| 564 | [BugFix] MP4 full duration and multivalue artists | Require complete MP4-family reads for duration and retain multivalue artist credits | Prevent partial-file duration corruption and artist loss | 🔄 进行中 |
| 565 | [Refactor] pnpm迁移 | 工作区、锁文件、脚本和 CI 使用 pnpm | 用户要求自有仓库全部替换 | ✅ 已完成 |
| 566 | [Operations] catalog_native_delivery | Deliver native metadata verification and guarded catalog reconciliation | Complete source coverage and repair catalog identity and statistics | 🔄 进行中 |

| 567 | [Maintenance] Kit依赖升级 | 更新已使用的公共 kit 包和锁文件 | 使用最新已发布的共享组件 | ✅ 已完成 |
| 568 | [Feature] Library file actions | Navigate from library entries to the exact file and expose confirmed deletion | User requested direct library file management actions | ✅ 已完成 |
| 569 | [Feature] WAV FLAC lossless tool | Tools 内本地 WAV 转 FLAC 并验证样本、规格与元数据 | 用户希望减少存储空间且保持无损 | ✅ 已完成 |

| 574 | [BugFix] Folder delete partial failure recovery | Apply catalog cleanup after each successful R2 deletion and preserve remaining entries for retry after a later failure | Prevent R2 objects from becoming catalog ghosts during partial folder deletion | ✅ 已完成 |
| 575 | [BugFix] Library tag editor initial metadata race | Wait for complete song metadata before opening the editor and discard stale asynchronous responses | Newly uploaded song album artist and year were missing in the editor | ✅ 已完成 |
| 576 | [BugFix] Song response album year | Include the joined album year in song query rows and Subsonic child responses | Album year remained blank in single-song editor fetches | ✅ 已完成 |
| 577 | [Feature] Work mode lossless queue | Select work types and verify guarded WAV to FLAC catalog replacement | User requested selectable jobs in Work Mode | ✅ 已完成 |
| 578 | [Feature] Workmode lossless | Browser queued compression preserves decoded audio and metadata | Execute lossless compression through the existing work pool | ✅ 已完成 |
| 579 | [Feature] Workmode selectable jobs | Parsing, transcode, metadata retrieval and lossless job choices | Replace the standalone WAV conversion pane | ✅ 已完成 |
| 580 | [Feature] Workmode task integration | Integrate, verify and deploy selectable work jobs | Deliver the requested Work Mode workflow end to end | ✅ 已完成 |
| 581 | [Audit] Workmode lossless runtime | Local browser and D1/R2 lossless replacement verification | Validate catalog, reference and failure behavior | ✅ 已完成 |
| 585 | [Feature] Workmode retrieval action | Explicitly restart metadata retrieval for songs missing metadata with paginated progress | User requested manual forced metadata retrieval | ✅ 已完成 |
