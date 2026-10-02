# 调研
- 主目录含大量无关未提交文件；从 main 23cdff9 建立独立 worktree。
- Windows 主机采用 C:/Users/User/.codex/worktrees/lsy-404@edgesonic，保留所有现有 worktree。
- GitHub main 当前 protected=false，远端头为 23cdff95c4896e1781a604e861e1ee6dda40431f。
- Fluent 当前 0.2.3，最高已发布 Fluent 包为 fluent-v0.2.5。
- Library 常规列表无限滚动，搜索数量也有独立限制。
- 提交 SSH 签名进程因外部交互未返回；终止本次签名进程，使用单次 commit.gpgsign=false，不修改全局配置。

- 集成客户端分支的 Settings import 发生同一行冲突（新增 FluentSwitch 与包重命名），采用新包的两组件导入解决，typecheck 通过。
- 初轮浏览器基线使用空 stream 测试数据触发播放失败；改为内存生成的静音 PCM WAV 与有效歌词 XML。合并时 Vite 暂时缓存 conflict overlay；重新加载最终源码后消失。
- 页面过渡期间截图捕获旧路由/透明入场帧，增加路由标题与过渡完成等待，避免误判布局。
- 收藏源代码测试的两处旧断言与已存在的 FluentSelect/新增分页队列不符；更新断言并增加真实收藏末页播放验证，全部通过。
- 延迟响应测试在修复前复现 size reset 后出现 song-81；修复 e33afed 后排序和页长重置保持 Page 1。
- 对照主目录现存任务发现编号已被并发任务占用，将本次审计重新编号为 549 至 552，避免覆盖无关记录。
- 远端 main 更新为 2d04cac，涉及专辑身份模块；需合并已提交更新，保留主目录全部未提交内容。
