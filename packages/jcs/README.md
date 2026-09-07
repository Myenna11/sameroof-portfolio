# @sameroof/jcs

RFC 8785（JSON Canonicalization Scheme）的最小实现，零依赖。

同屋里所有 `params_digest` 都按这一个定义算：

```
params_digest = sha256( UTF-8( JCS(params) ) )   // 小写 hex
```

**客厅（`packages/living-room`）和能力网关（`packages/gateway`，白板 G1）两边必须都用这个包算摘要**，不要各自再写一份；两边算出来不一致，执行型审批就会被客厅 400 拒掉（`APPROVAL-DIGEST-MISMATCH`），网关也不会消费决定。

## API

```js
const { canonicalize, digest, parseStrict, JcsError } = require('@sameroof/jcs');

canonicalize({ b: 1, a: [1e30, 4.50] });   // '{"a":[1e+30,4.5],"b":1}'
digest({});                                 // '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
parseStrict('{"a":1,"a":2}');               // 抛 JcsError JCS-DUPLICATE-KEY
```

- `canonicalize(value) → string`：键按 UTF-16 code unit 排序；数字按 ES `Number.prototype.toString`（与 `JSON.stringify` 一致，`-0 → 0`）；字符串转义按 `JSON.stringify`。
- `digest(value) → string`：上面那条公式。
- `parseStrict(text) → value`：自己写的小递归下降 JSON 解析器。`JSON.parse` 挡不住重复键（后者覆盖前者），这里直接拒；也不接受任何 JSON 之外的语法、尾随内容、控制字符。`__proto__` 当普通自有属性存，不污染原型。
- `JcsError.code`：`JCS-NUMBER-INVALID`（NaN/±Infinity/超出 double）、`JCS-TYPE-INVALID`（undefined/函数/symbol/BigInt/Date 等非普通对象）、`JCS-CYCLE`、`JCS-DEPTH-EXCEEDED`（容器嵌套 > 64 层）、`JCS-STRING-TOO-LONG`（单个字符串或键 > 1 MiB）、`JCS-DUPLICATE-KEY`、`JCS-PARSE`。

## 给网关的注意事项

- 从**文本**拿到 params（socket body）时用 `parseStrict` 而不是 `JSON.parse`，否则重复键会被静默吞掉，两边摘要可能算不到同一份数据上。
- 摘要只对 `params` 算，不含 `action`、`resident_id`、`gateway_request_id`——那三个字段网关逐字段比。
- 深度 64 的口径：顶层容器算第 1 层，第 65 层容器即拒；序列化与解析一致。
