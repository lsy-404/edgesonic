# 发现

- 管理员回收接口统计重新入队数量后直接返回响应，没有通知 WorkCoordinator。
- 定时回收工具在存在重新入队记录时会调用 `wakePool`。
- 初次运行测试时，此隔离 worktree 缺少已安装依赖，无法解析 Hono 与 TypeScript；需按锁定文件安装依赖后重试。
