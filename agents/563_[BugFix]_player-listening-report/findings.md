# 调研与行为契约

- `/rest/scrobble` 的 `submission=true` 写歌曲播放注释；`time` 单位为毫秒。调用受 `edit_annotations` 权限保护。
- 播放器只在活动 audio 的 `timeupdate` 累计真实 media-time 增量。首个时间点只建立基准；暂停不累计；seeking/seeked 重新建立基准；倒退或超过 5 秒的时间跳变不计入收听时长。
- 达到 `min(duration / 2, 240 秒)` 后每轮播放至多提交一次，支持约 2 秒短曲。队列替换、显式切曲和单曲自然重播开始新轮次。没有目录 ID 的 `file:` 直播放不提交。
- 只在收到成功的 Subsonic 响应后增加全局响应式 revision；已打开首页据此刷新热门与最近榜单。接口失败静默，不影响播放。
- `catalogId` 同时服务收藏与 getSong 元数据读取，保留其原有 ID 返回行为；上报单独过滤无 libraryId 的 `file:` 或自带 streamUrl 的曲目。文件已入库时使用 libraryId 仍可上报。Radio/Podcast 当前没有网页播放器队列入口，外部 streamUrl 曲目会被排除。
- 时间事件同时校验触发事件的活动音频元素绑定 ID 与当前曲目 ID。切换时的旧元素事件和 inactive 预载事件不进入进度状态；源回退沿用同一元素/曲目映射，单曲 ended 后重置为新一轮。
- 行为测试通过暂停续播、长短跳转、短曲、重复轮次、长曲门槛；预载和播放失败通过“不产生活动推进”模拟确认不会触发上报。
