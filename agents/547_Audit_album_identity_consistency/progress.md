# 操作记录
- 已读取 agent-mode skill、项目 local.instructions.md 和 project.md。
- 已运行 `git worktree list`，确认专属目标目录和分支未占用；以基线 `23cdff95c4896e1781a604e861e1ee6dda40431f` 创建 `codex/album-identity-consistency` worktree。
- 阅读 `albumIdentity.ts`、`metadataApply.ts`、`tag/read.ts`、`tag/write.ts`、storage scan/upload dispatch、标签解析、前端 albumArtist 字段传递、查询映射和既有回归。
- 修改 `worker/src/endpoints/tag/read.ts`：当 album 名不变且已有 album artist，但重读标签没有 album artist 时，保留 master 当前 album ID；hash identity的专辑艺人来源也优先使用已存 AA。明确写入的 AA 和 album 名变更沿用既有行为，source-folder ID 优先，compilation规则不变。
- 在 `test/internal/album_artist_roundtrip.test.ts` 添加物理 ID3 `/tag/read` 回归：不同 track artist、缺失 embedded AA、已有 album AA及非compilation arbitrary album ID，断言重扫后专辑ID和AA保持，track artist更新。
- `npm ci --ignore-scripts` 在隔离 worktree 安装依赖。第一次测试缺少 worktree依赖，初次运行 typecheck发现可空收窄错误，已修正。
- `npm exec tsx -- test/internal/album_artist_roundtrip.test.ts`：ALL PASS，覆盖既有 compilation、source-folder和不同folder/codec edition断言。
- `npm run typecheck -w worker`：通过。
- `git diff --check`：通过。未触碰生产资源。

- 首次定向测试 ALL PASS，worker typecheck通过；首个实现提交 `ea4940ed638066ff451175373fd1b4a36d184cef`。
- 跟进修正 metadata worker：仅扫描/解析入口开启 scanIdentity；同 album 名（NFC、移除『』、忽略空白、大小写）采用当前规范名并保留当前专辑 ID，显式不同 album artist 与真实不同专辑名仍走原有重算逻辑。手动 tag/write 不变。
- 在真实 SQLite fixture 中覆盖 metadata apply 和 `/tag/read` 两入口的引号/空白与 NFD 等价名、custom album ID、真实不同专辑名和显式不同专辑艺人；已有 compilation、source-folder、不同folder/codec版断言也通过。
- 最新 `npm exec tsx -- test/internal/album_artist_roundtrip.test.ts`：ALL PASS。最新 `npm run typecheck -w worker` 和 `git diff --check`：通过。未触碰生产资源。
- 核验消费者与全库snapshot聚合：专辑duration经Subsonic mapAlbum暴露；1,392/1,510 stored duration与masters实际SUM不一致。补metadataApply与tag/read聚合，并确保tag/read迁移旧album也纳入；duration-only metadata apply在master更新后刷新聚合。
- 扩展实际SQLite回归：metadata apply 以format.duration=30回填NULL master时长，album从0修为40；tag/read真实route将album缓存0刷新为两曲duration和12。定向测试 ALL PASS，worker typecheck通过，diff check通过。
- 对21个缺时长实例的当前R2对象执行只读下载/ffprobe；生成根545的remaining_metadata_audit.json、remaining_metadata_tracks.csv、duration_probe_plan.json。下载总393,811,386字节，20次probe有效、1个wav对象Invalid data；无上传、无生产写入。
