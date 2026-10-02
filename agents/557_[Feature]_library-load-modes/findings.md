# 调研与结论

- `GET /edgesonic/stats/library` 提供全库缓存的 artists/albums/songs 数量与 `ready`、`stale`。仅在 `ready && !stale` 时采用未过滤歌曲数；该接口不提供搜索、收藏或器乐过滤后的计数，也不能计算分组卡片总量。
- `getArtists` 与 `getStarred2` 返回各自完整列表，因此加载成功后可从内存数组精确计页。普通专辑仅在专辑偏移请求确认 EOF 且分组摘要加载完成后精确计页；折叠后的卡片数就是实际页数。收藏专辑不做分组，完整列表可直接计数。
- 普通歌曲计数仅在干净缓存可用或歌曲分页确认 EOF 后精确；隐藏伴奏时使用过滤后的完整歌曲数组，必须等 EOF 才能给精确数。搜索 API 无总命中数，使用 lookahead/EOF 维护未知总量的下界；只有确认 EOF 后才显示精确页数和直接跳页。
- 自动模式显示已加载前缀，滚动哨兵逐批加载并追加；手动模式保留单页切片。搜索艺术家结果按页缓存，防止自动模式换页丢失前页。播放队列按自动前缀或手动页偏移映射到歌曲数组。
- 专辑/歌曲分页与搜索必须先确认收到 status 为 `ok` 的合法 Subsonic XML 根响应，再按结果长度判断 EOF；`authFetch` 会返回非 2xx 响应体，因此 503 文本不能直接交给 XML 属性解析器，否则会被误判为空成功页。空响应、缺少 status 与其他非成功状态均视为失败。协议 failed 响应仍保留原 error code/message，包括歌词索引准备中的专用状态。
- [测试结果] `npx tsx --test test/web/library_load_modes.test.ts` 三项通过；`npm run typecheck -w web` 通过。第一次 typecheck 因隔离 worktree 缺少已安装的 Fluent 包而报模块无法解析；从集成 worktree 的 node_modules 补齐忽略文件后复跑通过。
