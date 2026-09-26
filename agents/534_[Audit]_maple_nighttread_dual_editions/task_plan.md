# 枫烬-夜屠灵双版归档与显示组

- [x] 从 production primary 只读枚举 20 个 WAV/MP3 masters，并固定 master/instance/object/entry/parent/path/physical-key/title/duration 身份。
- [x] 通过 Wrangler 获取全部 R2 对象，核对对象长度、音频 metadata 和 10 组 decoded PCM hashes。
- [x] 根据 PCM evidence 保留两版，建独立 edition albums 与一个 display group。
- [x] 生成精确 D1 守卫、最新 primary SELECT-only preflight，并重算 pending/WAV/MP3 album cache。
- [x] 使用真正 Wrangler local 演练成功、过期快照、并发身份变化与末段失败；比较失败前后完整相关表指纹。
- [x] 记录 primary 预检及 PCM/测试回执；仅提交本任务目录与 /test。
- [x] 不执行 production 写入。
## Sidecar 封面关联补充

- [x] 只读核对根目录与歌词目录 cover 的 D1 身份、companion_of、R2 字节与图像差异。
- [x] 审阅封面读取、缓存与清理接口的 key 约束，决定不破坏 storage sidecar 的归属方案。
- [x] 更新 apply/preflight SQL 的封面身份守卫与 canonical album cover keys。
- [x] 扩展本地 fixture、全表指纹与 sidecar 过期/身份过期/并发/末段失败回滚演练。
- [x] 写 sidecar 证据与 R2 staging 前置要求；本轮未生产写入或删除。
