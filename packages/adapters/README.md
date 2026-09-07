# 适配器公共件（packages/adapters）

`lib/room.js`：所有运行时共用的醒/睡循环。运行时（claude-code / pi / broker-direct）只需实现 `think(system, user, signal) → reply`。

## 房子在哪（house root）

`@sameroof/house-root` 的 `resolveHouseRoot()` 按序找含 `house.yaml` 的目录：

1. 环境变量 `SAMEROOF_ROOT`（指向的目录必须有 `house.yaml`，否则报错）
2. 从当前目录向上逐级找 `house.yaml`（git 式；服务的 WorkingDirectory 在仓库里就靠这条）
3. 兜底 `~/.sameroof`

三条都空就报错，把试过的路列出来。旧名 `SAMEROOF_HOUSE` 不再认（不留兼容期）。解析器在 `packages/house-root`。
`lib/room.js` 懒解析：只有真开房间（`open`）时才找，纯函数测试不碰盘。living-room 的 `server.js` 也用这同一份。

## 例行（routines）

定时的事不靠心跳撞，写成例行。配置在 `house.yaml` 或 `room.yaml` 的 `extensions["dev.sameroof.routines"]`（审查员升核心字段前先放这里）：

```yaml
extensions:
  dev.sameroof.routines:
    - id: morning-check          # 唯一
      cron: "0 9 * * 1-5"        # 分 时 日 月 周；支持 * , - /；周 0/7 都是周日；时区按房子（房间 schedule.timezone 非 inherit 时按房间）
      prompt: 看一眼惦记本，把今天要做的事对家里人说一句
      enabled: true              # 可省
      quiet_hours: ignore        # ignore（默认，例行是明写的）| respect（安静时段跳过）
```

- 房子的例行先，房间追加，同 id 房间覆盖房子。字段缺、cron 非法、id 重复 → 启动即抛。
- 到点以 `routine` 车道醒（human > routine > agent > heartbeat），提示为 `【例行】<prompt>` 加未读客厅记录；inbox 空不算 nothing，没 @ 也不 deferred。
- 同一分钟只触发一次；进程没跑时错过的不补跑，启动时 stderr 记一行。
- 计入当日 `wakes_today` 预算；不归零心跳退避；发言 hop=0。
- 状态在 `state/adapter-<id>.json` 的 `routines[id] = { last_fired, fired, skipped_quiet }`。

测试：`cd packages/adapters && npm test`。

## 接缝怎么走通（seam-walk）

`test/seam-walk.test.js` 就是 W6 每晚要走的那条链，用真 `run()` + 真客厅（`createLivingRoom`）走一遍：甲在客厅 @乙 → 乙醒（human 车道）→ 回 `APPROVAL:` → 适配器向网关登记 intent → `approval_body` 原样交客厅 → 甲同意/拒绝 → 网关拉 `/internal/gateway/approval-results` 决定流、把结果投回 `/internal/gateway/results` → 客厅 `kind=result` 只投乙 → 乙被 interrupt 叫醒、看到 `[网关结果 succeeded|denied]` → 说一句；最后把网关 socket 关掉，确认 fail closed（runs 记 `gateway_unavailable`，客厅没有新审批）。

网关是假的：`test/fixtures/mock-gateway.js`，零依赖 node http 听 Unix socket，只做 GATEWAY.md §2.1 的 `POST /v1/intents`（token、Idempotency-Key、JCS 摘要、同 request_id 幂等）和 §3.2/§3.3 的消费端（`pump(livingRoomBase, serviceToken)`：拉决定流、**不真执行**、直接投 `status: succeeded|denied`、`coverage.executor: 'mock'`）。G1 真网关出来后换真网关只改 socket 路径（`SAMEROOF_GATEWAY_SOCK` / `SAMEROOF_GATEWAY_TOKEN_FILE`），断言不动。

跑法：`cd packages/adapters && node --test test/seam-walk.test.js`（房子、客厅、网关、token 都在临时目录，不碰真房子；`run()` 用 `opts.signal` 收尾、`opts.lr` 指临时客厅）。

## 上下文怎么拼（context）

每次醒来 `room.js` 拼 `system` + `user`，纯函数在 `lib/context.js`。三条规则：

1. **每次醒都变的一律放 user 侧**：时间、在场的人、为什么醒、`【我记得的事】`（召回）、刚才的话、私信往来，都在 user 开头（例行 / 收件箱之前）。system 只放一班内稳定的东西：人设、规矩、交接信、惦记本、小本——好命中 prompt cache。
2. **刚才的话 / 私信往来打分挑选 + 摘要帧**：候选 = `/history` 最近 `recent_messages * 2` 条（上限 60）里未读之外的，按下表打分取最高 `recent_messages` 条，**按时间重排**后渲染；总字数超 `recent_max_chars` 从**分低**的丢（不是从旧的丢）。私信往来同样打分，只在该 partner 的 dm 历史内，`dm_recent` / `dm_max_chars` 封顶不变。渲染是摘要帧：文字原样（超 `frame_max_chars`，默认 400，截断加 `…`）；同一人连续的短消息不合并。`state/runs/<id>.jsonl` 的 `context.recent_scored` 记前 20 条 `{id, score}`，事后能看为什么选了这些。
3. **工具留壳**：住户有手（能力网关）之后客厅里会出现工具调用/结果消息。凡 `meta.kind === 'tool'`（或文本以 `[工具` 开头）的消息，在刚才的话、私信往来、收件箱里都只显示 `[工具调用: X]`（X 取 `meta.tool`，否则取方括号里的词），结果不展开——模型要看结果，等网关"结果投回收件箱"那条正文消息。

打分表（`scoreRecent`）：

| 条件 | 分 |
|---|---|
| @ 了我 | +3 |
| 我自己说的（保住"我已经回过"） | +2 |
| 发言人出现在本次 inbox 里 | +2 |
| 人类（species human） | +1 |
| 私信 | +1 |
| 距现在每过 1 小时 | -0.5（下限 -3） |

配置键（`house.yaml defaults.context` / `room.yaml context`）：`recent_messages`(20)、`recent_max_chars`(4000)、`frame_max_chars`(400)、`dm_recent`(10)、`dm_max_chars`(3000)、`memory_hits`(4)、`memory_recent`(3)。
