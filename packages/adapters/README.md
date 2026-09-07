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
