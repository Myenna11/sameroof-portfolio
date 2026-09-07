# @sameroof/quota · 配额气象台

家里几个 AI 用几家 provider，各家还剩多少额度，同屋自己查，前端「配额」tab 直接看。
只读：不刷新任何登录态、不写回任何文件、凭据只进请求头，永远不出后端。

## 形状

每家一张卡，压成同一个 schema：

```json
{ "provider": "kimi", "label": "Kimi Code", "residents": ["实现员"], "status": "ok",
  "message": "可选的一句话", "fetchedAt": "…",
  "windows": [{ "label": "5 小时窗", "usedPercent": 12, "resetAt": "2026-09-08T00:00:00.000Z", "detail": "10 / 100" }] }
```

- `usedPercent` 是唯一必需读数；算不出百分比的窗口不出（不伪造）。
- `resetAt` 优先，前端拿它算倒计时；没有就 `resetHint` 文案。
- `status` 只有 `ok` / `error` 两态，粒度是单家。错了带 `code` 和 `message`（原因说人话）。
- 上次拿到过好数据、这次错了：窗口照给，`stale: true`、`staleSince`，超过 20 分钟再加 `staleExpired: true`。缓存在 `state/quota-cache.json`。

## 各家怎么取

| provider | 住户 room.yaml 的 model.provider | 凭据从哪读（只读） | 接口 |
|---|---|---|---|
| claude | claude-code / anthropic | `~/.claude/.credentials.json`（`SAMEROOF_QUOTA_CLAUDE_CREDENTIALS`） | `api.anthropic.com/api/oauth/usage` |
| codex | openai-codex / openai | `~/.codex/auth.json`（`SAMEROOF_QUOTA_CODEX_AUTH`） | `chatgpt.com/backend-api/wham/usage` |
| kimi | kimi-coding / kimi / moonshot | pi 的 `~/.pi/agent/auth.json`（`SAMEROOF_QUOTA_PI_AUTH`） | `api.kimi.com/coding/v1/usages` |
| glm | zhipu / glm / zai | broker 账本里的活跃凭证（`SAMEROOF_BROKER_DB`） | `<base>/api/monitor/usage/quota/limit`；按量 key 没有 coding plan 时改用 broker 本地账本（token 预算、今日用量） |
| deepseek | deepseek | broker 账本 | `api.deepseek.com/user/balance`（余额只出文案，没有百分比） |

取数方法参考 emmmdty/token-usage 与 Javis603/token-monitor，没装他们的东西。

## 诚实边界

- 登录态过期就报过期，不去刷新：Codex / Kimi 的 refresh 会轮换 token，和 CLI 自己抢写会把人家登出。
- 成功响应的解析是按参考实现的形状写的，夹具在 `test/`；**写这一版时本机四家都没有活登录态**，只有错误回包（Kimi 401、GLM「不存在 coding plan」、Codex `token_expired`）是真拿到的。等哪家登录态活了，拿真响应核一遍再改夹具。
- 单家失败不拖垮整体：`fetchAll` 并发，任一家抛错都兜成那张卡的 `status:"error"`。

## 用

客厅 `GET /quota`（只给 human token；60 秒内重复问给上次的，`?fresh=1` 强刷）。测试 `npm test -w @sameroof/quota`。
