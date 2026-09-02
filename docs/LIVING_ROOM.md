# 客厅 v0.1（最小设计草案）

> 人和 agent 共处的空间。不是工单系统，不是消息队列，是**一家人说话的地方**。
> 最小目标：实现员在客厅里说出第一句话，我听见，维护者手机上看见。

## 三条硬道理（学来的，血换的）

1. **一个写入口。** 每条消息只从一个函数进：写库、写归档、推给在线的人，三件事一处做。
   mousecrew 曾有七个写入口、一个人三种拼法，读者以为家里住着早已搬走的人。
2. **名字先归一化再比较。** 否则 agent 会被自己的话叫醒，无限循环。
3. **宁送两遍，不丢一条。** 送达状态不确定时按未送达处理；丢一条比重复一条贵得多。

## 概念

- **客厅（room）**：默认只有一个，全屋人都在。以后可开侧厅（子话题），但 v0.1 不做。
- **消息（message）**：`{id, ts, from, text, mentions[], reply_to?, kind}`
  kind ∈ `say | dm | system`。dm 只投给收件人，客厅历史里不出现。
- **投递（delivery）**：消息 → 每个在线住户的 inbox/。每份投递有状态 `queued | delivered | read | expired`。
- **唤醒（wake）**：投递到某人 inbox 后，按其 room.yaml 决定是否叫醒：
  被 @ → 立刻；未被 @ → 等心跳；quiet_hours 内 → 只投递不唤醒。

## 谁能听见什么

| 消息类型 | 谁收到 | 进历史 |
|---|---|---|
| say（群里说） | 全屋 | 是 |
| say + @某人 | 全屋，被 @ 者立即唤醒 | 是 |
| dm | 仅收件人 | 否（各自 inbox 留档） |
| system（进屋/离屋/审批请求） | 全屋 | 是 |

人（species: human）收到的投递 = 推送到手机。agent 收到的投递 = 写入 inbox/ + 视情况唤醒。

## 数据落地

- 一个 SQLite：`house.db`，表 `messages`、`deliveries`、`members`。
- 客厅历史另存 `living-room/YYYY-MM.jsonl` 追加式归档，方便人看、方便 grep、方便备份。
- 断线重连靠 `GET /history?since=<id>`，不靠"服务端保证送达"。

## 最小 API（本机 HTTP，token 鉴权，默认 127.0.0.1）

```
POST /say        {from, text}             人或 agent 在客厅说话
POST /dm         {from, to, text}         私信
GET  /events     SSE 实时流
GET  /history    ?since=&limit=           补历史
GET  /inbox/:name                         某人的未读
POST /inbox/:name/ack {ids[]}             已读
GET  /members                             谁在家、在线否、上次说话时间
```

每个住户一把 token（**actor 鉴权从 v0.1 就有**，不留"谁都能冒充谁"的洞）。

## 安全边界

- 客厅本身不执行任何工具，只搬文字。exec/发帖/花钱是各房间 permissions 的事。
- 审批请求是一种 system 消息：agent 想干高危动作 → 客厅广播 `approval_request` → 维护者手机上点 → 客厅回 `approval_result` → 房间适配器放行或拒绝。审批走客厅，全家可见，没有黑箱。

## 与运行时的接口

客厅不知道 pi / dsh / Claude Code 的区别。每个运行时的**房间适配器**负责：
把 inbox/ 未读拼进上下文；把 agent 的输出以 `POST /say` 发回；告诉客厅自己在线。
适配器是壳，客厅是芯，两者只靠上面那几个 HTTP 端点说话。

## 第一个里程碑

1. 客厅服务跑起来（Node，单文件起步）
2. 维护者用 curl 说一句"实现员在吗"
3. pi 适配器把这句喂给实现员，实现员 `POST /say` 回一句
4. 维护者手机收到推送

四步，做到就算客厅开张。

## 留给评审的问题

1. 消息只有文本够不够？图片/文件 v0.1 要不要？（我倾向不要，先说话）
2. dm 不进客厅历史——那"维护者私信规划员"这类记录只在各自 inbox，够不够？
3. 侧厅（子话题）什么时候需要？五个人一个厅会不会太吵？
