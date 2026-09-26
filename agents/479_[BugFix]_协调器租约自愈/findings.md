# 调研记录

[生产队列停滞] -> [检查 WorkCoordinator 的 dispatch 与 attachment] -> [holding 仅在 done、release、close/error 更新；D1 已重排或过期的租约不会清除 attachment，随后 headroom 可能永久为零。]

[部署或连接切换] -> [检查 close 路径] -> [即使 close 处理未运行或未完成，持久 attachment 仍可保留旧任务 id；下一次 dispatch 没有验证其 D1 所有权或心跳时效。]

[残留 socket 仍显示 OPEN] -> [查阅 Durable Objects Hibernation API] -> [getWebSocketAutoResponseTimestamp 可读取每个 socket 最后一次自动 pong 时间；客户端已每 25 秒发送原始 ping，可在不唤醒休眠对象的前提下排除失联 socket。]

[旧连接误回收新租约] -> [独立复核即时 release 与无条件 send-failure 回退] -> [attachment 只记录任务 ID，旧连接与同一用户的新领取无法区分；移除所有 socket 驱动的 D1 回退，统一以心跳过期条件回收。]

[每小时 Cron 延迟] -> [查阅 Durable Objects Alarms API] -> [有活连接时由对象每分钟自唤醒，先回收 D1 过期行，再校准本地 holding 并分发；全局 Cron 留作后备。参考 https://developers.cloudflare.com/durable-objects/api/alarms/。]

[回收 SELECT 与心跳交错] -> [在 UPDATE 中复核 status、heartbeat_at、attempts 和 max_attempts] -> [心跳或状态变化后的旧快照不改写新状态；依据 batch 返回的实际 changes 计数。]

[最后一个 socket 在领取 TTL 边界失活] -> [第一轮 alarm 的严格小于条件尚不回收，若对象停止 alarm 则只能等小时 Cron] -> [只要 D1 仍有普通领取行就重设 alarm，直至下一轮清理。]

[成功提交超时] -> [浏览器原流程随后发送失败提交，同一任务可能被先完成再重排] -> [失败报告只针对解码失败；提交响应失败时保留服务端状态由领取过期恢复。]

[旧领取回收后同名用户重新领取] -> [原提交与心跳只验证用户名，可能覆盖新领取] -> [浏览器传 attempts 与 claimedAt，所有心跳、错误和成功终态更新均以 D1 原子条件校验。]

[成功终态与元数据写入之间发生中断] -> [先保存原始 result_json；利用现有 error_message 保存 pending/applying 令牌，无结构迁移] -> [计划任务每次重放最多 20 条，旧应用租约 10 分钟后重新开放，清除令牌时校验 UUID。]

[重新扫描与应用租约交错] -> [原终态 upsert 会清掉 pending/applying 标记，旧请求随后仍写入曲目] -> [upsert 仅作用于终态且已结束应用的行；显式重扫遇到未结束应用时返回冲突。]

[手动补录与自动重放交错] -> [原补录会重放所有 completed 结果，绕过应用令牌] -> [仅选择未扫描实例且无应用标记的完成行，避免与自动重放和已应用任务并发。]
