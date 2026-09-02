# @sameroof/schema

同屋的房间/全屋配置合同。JSON Schema 管单文件结构，语义校验器管跨房间、凭证名录和权限上限。

## API

```js
const { validateRoom, validateHouse } = require('@sameroof/schema');

validateRoom('/path/to/room.yaml');
// => [{ file, line, code, message_zh, severity }]

validateHouse('/path/to/house');
// => 同一错误结构，包含 house.yaml 与 rooms/*/room.yaml
```

错误码含义稳定：

- `ROOM-*`：单间结构、身份、名字、权限；
- `HOUSE-*`：全屋配置与目录；
- `CRED-*`：凭证公开别名或认证模式。

校验器不修改文件、不填充默认值。默认值仍由 `house.yaml` 解释层提供。

## 运行测试

```bash
npm install
npm test
```
