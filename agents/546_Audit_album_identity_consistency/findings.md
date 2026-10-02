# 调查发现

## 问题与结论
- 文件/上传重解析由 `tag_scanned=0` 触发，分发至 metadata worker 的 `applyMetadataResult`；浏览器 `/tag/read` 是另一个物理标签解析入口。
- `relinkArtistAlbum` 在输入没有 albumArtist 时取当前 `album_artist_id` 对应名称，用它计算 album identity。`tag/read` 则只解析当前物理标签：TPE2 缺失时以曲目 artist 作为 `linkArtistName`，即使 master 已经有专辑艺人。
- 对非 sourcefolder、非 compilation 的已有关联曲目，`tag/read` 会用曲目艺人和 album 名生成新 ID；数据库更新同时通过 `COALESCE(incomingAlbumArtistId, album_artist_id)` 保留已有 AA，造成 identity 与字段不一致并拆出曲目。
- 最小修复只在 album 名相同且读取不到 AA 时保留 master 当前 album ID，并以当前 AA 参与 identity 选择。显式有值的 album artist、不同 album 名、目录和音频版本仍按现有规则；compilation与source-folder优先级不变。
- 更广风险：任一非空但与当前规范名不同的 incoming album name 会让 worker或 `/tag/read` 重算 identity；compilation只在专辑名相等时retain。source-folder identity也依赖目录、后缀和专辑名。手工合并不能覆盖冲突标签再次重扫；自动忽略冲突值可能吞并真实 side edition/rename，因此本修复不处理，需由数据审计作带证据的精确处理。
- 数据库和本次审计均只在本地测试 fixture/worktree 操作；不访问生产资源。

## 既有规范与保护
- `test/internal/album_artist_roundtrip.test.ts` 使用 SQLite/D1路由 fixture，覆盖 compilation路由、sourcefolder import、不同 folder/codec edition。
- 该测试要求 compilation对逐曲 album artist差异保持同组，显式 compilation AA改变或专辑改名会移出；source-folder identity按来源目录/音频后缀/专辑名隔离。

## 补充复核
- 自定义/人工合并的 album ID 不一定等于从当前AA和专辑名重新算出的md5；worker重解析即使AA未变化也可能改变ID。扫描入口现对匹配专辑名保留当前ID。
- 扫描入口把 `NFC + 删除『』 + 删除空白 + 忽略大小写` 后相等的 album name采用数据库当前原名。匹配为严格字符规则，不移除CD、伴奏、codec等后缀，不做模糊匹配。
- 非空且不同的incoming AA或真实不同专辑名仍走旧重算逻辑；手动 `/tag/write` 保持原语义。