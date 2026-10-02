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

## Full catalog integrity follow-up and duration cache evidence
- Read-only examination of the saved catalog snapshot found 1,392 album `duration` aggregates differing from `SUM(song_masters.duration)`, 2 `song_count` differences, and 5 `size` differences. Album duration is returned in Subsonic `mapAlbum` and browse/search paths, so stale stored values are client-visible.
- `metadataApply` and `/tag/read` were refreshing album count and size but not duration. Both now refresh `SUM(song_masters.duration)`; `/tag/read` also touches the former album when a scan moves a master, keeping its cached totals coherent. Metadata apply refreshes album duration for duration-only parse results after the master is updated.
- Regression uses SQLite: metadata apply fills a NULL master duration and asserts the album total becomes 40 seconds; actual `/tag/read` route asserts stored durations 5+7 update a stale album total to 12. The route parser has no duration field and is not expanded.
- Duration probe: 21 R2 objects (393,811,386 bytes) fetched read-only into the audit cache; all catalog sizes matched. Thirteen 32-hex source_etag values match byte MD5; eight MP4 rows have no comparable 32-hex etag. Full-object ffprobe got 20 durations; one WAV object exited 1 with `Invalid data found when processing input`. Nine M4A files contain fragmented MP4 `moof` boxes. The metadata executor only emits duration when `fullMp3DurationRead` is true (`web/src/workers/taskExecutor.ts`); its fragmented MP4 fallback also parses before `moof` with duration disabled. This accounts for the cross-format omissions and fMP4 subset; invalid WAV needs separate source validation.
- Other snapshot counts and per-track evidence are delivered to root audit directory as `remaining_metadata_audit.json`, `remaining_metadata_tracks.csv`, `duration_probe_plan.json`; no production D1/R2 mutation occurred.


## Metadata executor duration follow-up
- Full-file replay through the installed `music-metadata` 11.15.0 on the 20 cached non-WAV objects showed 9 fragmented MP4 files fail even on complete buffers with `Missing sampleDuration and no defaultSampleDuration in track fragment header`; the existing pre-`moof` tag fallback correctly cannot supply their durations. A tenth fragmented object is stored with an `.mp3` suffix.
- Eight regular MP4 objects have full-file durations in `music-metadata`; one additional regular MP4 reports no duration despite ffprobe reporting 13.333333 seconds.
- Two non-fragmented MP4 objects stored with `.mp3` suffix were misread as ADTS when the response MIME was `audio/mpeg`. Checking the standard `ftyp` signature and supplying the corresponding MP4 MIME lets `music-metadata` parse these two durations correctly.
- The worker now retries full reads only for `.mp4` files whose head slice has no duration (under the existing 300 MiB limit) and keeps a positive duration returned from the full parse even when the file has no text tags. It retains the partial-MP3 full-read guard and does not add any MP4 duration parser.
- Replayed all 20 cached valid objects through `runMetadata`: 9 emitted durations, each within 0.51 seconds of ffprobe. The remaining 11 valid objects are 10 fragmented MP4s unsupported by the installed library and one regular MP4 for which this library returns no duration. Exact replay results are in the root audit folder’s `duration_probe_task_executor.json`.
- The cached 25,305,212-byte WAV has every byte zero (SHA256 `edf644430b409995ba3435293d4b7a34452840cc7ad9518c18c7405fb622666d`, MD5 `0854d02caa5ebd8c986280d83df0c248` matching its 32-hex ETag). No same-key valid local cache copy was found. Do not infer or assign its duration.
