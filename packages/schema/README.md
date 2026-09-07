# @sameroof/schema

同屋的房间/全屋配置合同。JSON Schema 管单文件结构，语义校验器管跨房间、凭证名录和权限上限。

## API

```js
const { validateRoom, validateHouse, resolveExecutionConfig } = require('@sameroof/schema');

validateRoom('/path/to/room.yaml');
// => [{ file, line, code, message_zh, severity }]

validateHouse('/path/to/house');
// => 同一错误结构，包含 house.yaml 与 rooms/*/room.yaml

resolveExecutionConfig(house, room);
// => { deliver, limits, routines }，核心字段优先，旧 dev.sameroof.* extension 只作迁移回退
```

错误码含义稳定：

- `ROOM-*`：单间结构、身份、名字、权限；
- `HOUSE-*`：全屋配置与目录；
- `CRED-*`：凭证公开别名或认证模式。

校验器不修改文件、不填充默认值。默认值仍由 `house.yaml` 解释层提供。

核心 `context` 合同位于 `house.defaults.context`，房间根级 `context` 可局部覆盖；扩展字段不再承担上下文预算。
核心 `avatar` 位于房间根级，支持 `emoji` 与房间内相对 `image`。image 的越界路径、URL、symlink 或不存在文件会以
`ROOM-AVATAR-IMAGE-001` 拒绝。

运行队列的三个核心合同：

- `house.defaults.deliver` / `room.deliver`：`human`、`agent` 与逐发送者 `from` 的投递模式；
- `house.defaults.limits` / `room.limits`：单轮超时与 agent 链跳数；
- `house.routines` / `room.routines`：五段 cron 例行任务，房间同 id 覆盖房子。

`resolveExecutionConfig` 是 runtime 与 lock 的共同解析口：房间覆盖房子，缺省为 `after_turn`、180 秒、6 跳；迁移期仍读取
`extensions["dev.sameroof.deliver"]`、`extensions["dev.sameroof.limits"]`、`extensions["dev.sameroof.routines"]`；同一层只要存在核心字段就不再读对应 extension。

## 运行测试

```bash
npm install
npm test
```
