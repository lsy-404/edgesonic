# 枫烬-夜屠灵双版归档与显示组

- [x] 从 production primary 只读枚举 20 个 WAV/MP3 masters，并固定 master/instance/object/entry/parent/path/physical-key/title/duration 身份。
- [x] 通过 Wrangler 获取全部 R2 对象，核对对象长度、音频 metadata 和 10 组 decoded PCM hashes。
- [x] 根据 PCM evidence 保留两版，建独立 edition albums 与一个 display group。
- [x] 生成精确 D1 守卫、最新 primary SELECT-only preflight，并重算 pending/WAV/MP3 album cache。
- [x] 使用真正 Wrangler local 演练成功、过期快照、并发身份变化与末段失败；比较失败前后完整相关表指纹。
- [x] 记录 primary 预检及 PCM/测试回执；仅提交本任务目录与 /test。
- [x] 不执行 production 写入。
