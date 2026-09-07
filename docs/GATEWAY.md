# 能力网关合同与安全设计（Y1）

状态：Y1a 接口合同已钉死；Y1b v1 设计已钉死；G1 v2 已按 2026-09-07 审查员复核收紧运行根、策略版本和结果传输。
依据：`DECISIONS.md` #20、`docs/neighbors/2026-09-07-exec-boundary.md`。
范围：能力执行网关，不是消息/身份“总机”，也不代替客厅、房间适配器或 broker。

## 0. 不可退让的边界

1. 网关是独立进程。模型、房间适配器和客厅都不能直接执行能力动作。
2. 动作在有效策略结果出现前不得产生副作用。需要人工审批时，必须先结束当前住户轮次。
3. `approval_id` 只消费一次；`resident_id`、`action`、`params_digest`、有效期任一不匹配即拒绝。
4. 文件动作由网关按路径规则直接代做；shell 动作只能进 bwrap。
5. bwrap 缺失、探测失败、启动失败或边界无法证明时 fail closed，不得裸跑或“沙箱外重试”。
6. 网络默认断。v1 不提供临时开全网的审批选项。
7. 扩权只能增加一条明确的可写根后在沙箱内重跑；不能关闭沙箱。
8. 所有请求都产生 `asked` / `decided` 成对审计记录；执行和结果另记，日志只追加不改写。

## 1. 进程与信任边界

```text
住户模型（不可信文本）
  -> 房间适配器（解析动作，不执行）
  -> gateway.sock（登记不可变 intent）
  -> 客厅（展示审批、记录人的决定）
  -> 网关（独立读取权威 approval_result）
  -> 路径执行器或 bwrap（真正产生副作用）
  -> 客厅内部结果口（只投给申请住户）
  -> 收件箱 -> human 车道唤醒住户
```

- 适配器提交的 `resident_id` 不是身份凭据。Unix peer credential 只用于确认调用者属于允许的本机服务；具体住户身份必须由一枚网关签发的 opaque adapter token 绑定，不能相信 body 自报身份。
- adapter token 每住户一枚，网关只保存 hash。运行时文件放 `/run/sameroof-gateway/tokens/<resident_id>`，`0640`，由服务管理器只交给对应房间进程；请求使用 `Authorization: Bearer`。token subject 与 body 的 `resident_id` 不同即拒绝。
- 当前 room units 都以 root 运行，root 理论上能读取别人的 token，因此 v1 的“住户间 OS 身份隔离”尚不成立；上线宣称隔离前要把每个 room unit 拆成独立 service user。即使尚未拆用户，G1 仍必须实现逐住户 token，不能以 root peer 直接信任 body。
- 客厅普通住户 token 不能调用网关内部接口。网关使用一枚独立、窄权限的 service token，只允许读取审批决定和写入执行结果。
- service token 放在 `/var/lib/sameroof-gateway/living-room.token`，`0600`，不得进入仓库、日志、错误详情或子进程环境。
- gateway 生产入口拒绝 uid 0。systemd unit 必须使用 `User=sameroof-gateway`；该用户只拥有自己的 state/runtime 目录及显式授权的数据根，不能读取 broker、客厅或其他服务的状态目录。
- 模型给出的内容、文件内容、stderr 和记忆都只是数据，不能改变本文策略。

## 2. Y1a：适配器到网关的接口合同

网关监听 `/run/sameroof-gateway/gateway.sock`，HTTP/1.1 over Unix socket，JSON UTF-8。body 上限 256 KiB；未知字段拒绝。adapter 请求同时校验 Unix peer 与逐住户 Bearer token。所有写请求必须带 `Idempotency-Key`，值等于 `request_id`。

### 2.1 登记 intent

`POST /v1/intents`

```json
{
  "request_id": "req_01J...",
  "resident_id": "resident_builder_01",
  "run_id": "run_01J...",
  "action": "core.fs.write",
  "params": {
    "root_id": "own-room",
    "path": "notes/today.md",
    "content": "...",
    "mode": "replace",
    "expected_sha256": "optional lowercase hex"
  },
  "requested_ttl_seconds": 1800
}
```

网关先完成结构校验、权限上限判断、路径词法归一化和 target 指纹计算，但不接触目标文件。成功返回：

```json
{
  "request_id": "req_01J...",
  "state": "awaiting_approval",
  "action": "core.fs.write",
  "params_digest": "sha256 lowercase hex",
  "target_digest": "sha256 lowercase hex",
  "expires_at": "2026-09-07T12:34:56.000Z",
  "approval_body": {
    "action": "core.fs.write",
    "params": {"root_id":"own-room","path":"notes/today.md","content":"...","mode":"replace"},
    "params_digest": "same digest",
    "gateway_request_id": "req_01J...",
    "ttl_seconds": 1800
  }
}
```

适配器必须原样把 `approval_body` POST 给客厅 `/approval`，随后结束本轮。它不能把自然语言重新解析一遍后再拼另一份 params。

重复的 `request_id` + 完全相同 payload 返回原记录；相同 id + 不同 payload 返回 `409 GW-IDEMPOTENCY-CONFLICT`。

### 2.2 摘要算法

- `params_digest = sha256(UTF-8(JCS(params)))`。JCS 指 RFC 8785 规范化 JSON；拒绝 `NaN`、Infinity、重复键、超限深度和超限字符串。
- 客厅对带 `gateway_request_id` 的审批必须自己重算同一摘要并与 body 比较；不一致返回 400，不创建审批。
- 重复键必须在网关从原始 intent 文本入口用 strict parser 拒绝。客厅可以在普通 JSON 解析后重算摘要：执行型审批必须先有不可变 gateway intent，解析后对象若不能与该 intent 摘要完全匹配，网关不会执行。
- 当前客厅 `JSON.stringify(params)` 的旧摘要只保留给非执行型旧审批；网关不得消费旧摘要。
- 除摘要外，网关仍逐字段匹配 `resident_id`、`action` 和 `gateway_request_id`。摘要不是身份认证。

### 2.3 查询 intent

`GET /v1/intents/:request_id` 只允许 token subject 等于该 intent 住户的适配器，或本机管理 CLI。响应不回显大段 `content`、命令环境或秘密，只给状态、摘要、时间和安全裁剪后的结果。

状态机：

```text
received -> awaiting_approval -> approved -> executing -> succeeded|failed|timed_out
                            \-> denied|expired
                            \-> abandoned
```

- 只有 `awaiting_approval -> approved` 的事务能认领一条权威允许决定。
- `approved -> executing` 与写入一次性消费标记必须在同一事务提交。
- 进程在 `executing` 时崩溃，重启后标成 `failed_unknown`，不得自动重放可能已有副作用的动作。

## 3. Y1a：客厅与网关的内部合同

这是 W3/G1 的接缝。客厅仍只搬字和保存人的决定，不执行动作。

### 3.1 审批创建补充字段

客厅 `/approval` 对执行型审批新增并要求：

- `gateway_request_id`
- `params_digest`

客厅存储两者，并把 `gateway_request_id` 放进 `approval_request` / `approval_result` 的 meta。一个 `gateway_request_id` 最多绑定一个 `approval_id`。

### 3.2 权威决定流

`GET /internal/gateway/approval-results?after_seq=<n>&limit=<1..100>`

仅 loopback + gateway service token。按单调 `seq` 返回：

```json
{
  "items": [{
    "seq": 42,
    "approval_id": "apr_...",
    "gateway_request_id": "req_...",
    "resident_id": "resident_builder_01",
    "action": "core.fs.write",
    "params_digest": "...",
    "decision": "allowed",
    "remember": "once",
    "decided_by": "resident_operator_01",
    "decided_at": "...",
    "expires_at": "...",
    "single_use": true
  }],
  "next_seq": 42
}
```

该流必须可从持久化游标补读，不能只靠 SSE 或进程内 callback；这样客厅或网关重启不会丢决定。网关把游标持久化到自己的事务库。`params` 不需要再次传输，因为不可变 intent 已在网关；客厅只返回权威绑定字段。

网关只在以下全部成立时消费允许：记录存在、`decision=allowed`、未过期、`single_use=true`、四个绑定字段完全一致、`approval_id` 未消费。否则终态拒绝并审计。有效期取 `min(intent.expires_at, approval.expires_at)`；任一缺失、格式错误或已经到期都 fail closed。

### 3.3 结果投回

`POST /internal/gateway/results`

仅 loopback + gateway service token；`request_id` 为幂等键。body：

```json
{
  "request_id": "req_...",
  "approval_id": "apr_...",
  "resident_id": "resident_builder_01",
  "action": "core.fs.write",
  "status": "succeeded",
  "coverage": {
    "executor": "path-rules",
    "network": "denied",
    "requested": ["own-room:notes/today.md"],
    "completed": ["own-room:notes/today.md"]
  },
  "next": {"kind": "none"},
  "summary": "已写入 notes/today.md",
  "details": {"bytes_written": 123, "sha256": "..."}
}
```

客厅创建一条只投给 `resident_id` 的 system/inbox 消息，meta 带完整小结果，不公开到客厅历史；协议投递模式使用现有的 `interrupt`，`kind=result` 必须使住户从 human 车道醒来，不新增同义的 `wake` 值。相同 `request_id` 重试必须返回同一 `message_id`，不能重复投递。

客厅必须严格校验上述已知安全字段、类型、长度和绑定关系；为了 G1/W3 独立演进，内部结果 body 的未知字段可以忽略。第 2 节“未知字段拒绝”只约束网关自己的 adapter 入口。

G1 v1 的结果传输采用“小结果内联”，不是 blob 引用。gateway 在发送前把序列化 body 限制在 60 KiB（低于客厅 64 KiB HTTP 上限）；正常动作按动作级上限保证不会触线。防御性检查若发现内部结果超过 60 KiB，会改投一条小型 `GW-RESULT-TOO-LARGE` 终态结果，而不是把同一超大 body 永久留在热重试队列。客厅的 `summary` 是住户实际收到的结果正文；`details` 只承载小型结构化副本。

## 4. v1 动作字典

未登记动作一律 `GW-ACTION-UNKNOWN`。v1 只实现三类：

### 4.1 `core.fs.read`

```json
{"root_id":"own-room","path":"memory/index.md","max_bytes":1200}
```

- 由网关直接读取；默认与硬上限均为 1200 bytes。这是 v1 内联传输的端到端上限，不是底层读取能力上限。
- 只读普通文件；目录、设备、FIFO、socket、符号链接全部拒绝。
- 完整 UTF-8 放进 `summary` 和 `details.content`；非法 UTF-8 以 base64 放进 `summary` 和 `details.content_base64`。1200 bytes 的 base64 加协议外壳仍低于客厅的 summary/details/body 上限。

### 4.2 `core.fs.write`

```json
{
  "root_id":"own-room",
  "path":"notes/today.md",
  "content":"...",
  "encoding":"utf8",
  "mode":"create|replace",
  "expected_sha256":"optional"
}
```

- 由网关直接写，不起 shell。
- v1 只写普通文件；不 chmod、chown、删、移动、递归创建目录，也不跟随链接。
- `create` 使用 exclusive create；`replace` 要求目标已存在且为普通文件。
- 建议写临时文件、fsync、原子 rename；若提供 `expected_sha256`，不匹配即拒，防止覆盖并行 WIP。
- 单次 content 硬上限 1 MiB。

### 4.3 `core.exec`

```json
{
  "argv":["npm","test","--","gateway"],
  "cwd":{"root_id":"project-sameroof","path":""},
  "writable_root_ids":["project-sameroof"],
  "timeout_ms":30000,
  "env":{"NODE_ENV":"test"}
}
```

- `argv` 必须是非空字符串数组，不接受隐式 shell 字符串；需要 shell 语法时必须显式写 `['/bin/sh','-lc',...]`，target 指纹覆盖完整 argv。
- 环境从空白 allowlist 构造。v1 只允许 `LANG`、`LC_ALL`、`TZ`、`NODE_ENV`；不继承 broker、客厅、网关或宿主秘密。
- stdout/stderr 各最多 256 KiB，超出截断并在 coverage 标记；默认 30 秒，硬上限 10 分钟。
- 只允许配置声明的 cwd 与 writable roots；命令不能临时请求任意宿主路径。

## 5. 结果形状：`status / coverage / next`

所有执行和拒绝都返回同一外壳：

```json
{
  "status": "succeeded|failed|denied|expired|timed_out|failed_unknown",
  "coverage": {
    "executor": "path-rules|bwrap|none",
    "sandbox": "enforced|not_applicable|unavailable",
    "network": "denied",
    "requested": [],
    "completed": [],
    "stdout_truncated": false,
    "stderr_truncated": false
  },
  "next": {
    "kind": "none|request_writable_root|retry_in_sandbox|human_action",
    "root_id": "optional",
    "path": "optional",
    "reason": "optional safe text"
  }
}
```

`coverage` 只陈述网关真正保护和完成的范围；不能把“命令退出 0”写成“目标业务已完成”。`next` 是机器可读建议，不具有授权效果。

## 6. Y1b：权限、可写根与配置形状

Y2 再把字段落进 schema / validator / lock；G1 先按此对象接受解析后的配置。

```yaml
gateway:
  approval_memory:
    ceiling:
      core.fs.read: session
      core.fs.write: once
      core.exec: once
  mounts:
    - id: project-sameroof
      path: /root/sameroof
      residents:
        resident_reviewer_01: read-write
        resident_researcher_01: read-only
```

- `own-room` 是保留 root id，不写绝对路径；由 house 根 + 当前住户实际 room 目录推导，不能由请求覆盖。
- 额外 mount 必须由户主写进 `house.yaml`，id 唯一，path 为已存在的绝对目录，resident 显式列名，权限仅 `read-only|read-write`。
- mount 不得是 `/`、house 根的父目录、其他住户房间、broker/gateway 状态目录或 `/run`。
- gateway 内存策略带已验证的 `house.lock.source.digest`。每次登记 intent 都先重新验证 lock 与全部 source 文件；digest 变化时，完整 schema/语义校验并二次复核 digest 后才原子切换。校验失败或重载期间再次漂移就拒绝新 intent，旧策略只留给已经登记的 intent。
- 每个 intent 持久化 `policy_digest` 与不可变策略快照。审批回来后按该快照执行；因此户主从 `approve` 收紧到 `deny` 并生成新 lock 后，新 intent 立即被拒，已经登记并获批的旧 intent 仍按登记版本完成。
- 权限最终值取硬编码 deny、house permissions ceiling、room permissions、mount access 中最严格者。任一层缺失或无法解析都 deny。

审批记忆 scope：`once < session < always`。户主 ceiling 是每个 action 可接受的最大 scope；人的选择超过 ceiling 时裁到 ceiling并在结果中明示。默认 ceiling 为 `once`。

## 7. 路径规则执行器

每个路径请求按以下顺序，任一步无法证明即拒：

1. `path` 必须是相对路径；拒绝 NUL、空段、`.`、`..`、反斜杠混淆和绝对路径。
2. 以 root fd 为锚逐段 `lstat`，任何现存段是符号链接即拒。
3. 对最深的现存祖先做 `realpath` 二核，必须仍在允许根内，使用“路径分隔符边界”比较，不能用字符串前缀。
4. 终点读取用 `O_NOFOLLOW`；写入不能先 truncate，先打开并通过 `/proc/self/fd/<fd>` 再核后才改写。
5. 新建文件要求父目录已存在且已二核；使用 `O_CREAT|O_EXCL|O_NOFOLLOW`，fd 二核失败立即关闭并删除刚创建的文件。
6. 操作后再核类型与路径，审计记录 root id、相对路径、最终 realpath 和摘要；对外结果不泄漏宿主绝对路径。

硬编码不可豁免的路径段/文件：

- `.git/hooks`、`.git/config`
- 任意 `.env` 或 `.env.*`
- `house.yaml`、`house.lock`
- `.sameroof/`
- 其他住户房间

规则按归一化后的每个路径组件匹配，大小写按宿主文件系统语义处理。配置不能取消这张表；新增保护项可以，移除只能改代码并重新评审。

## 8. bwrap shell 执行器

启动时以及每次配置重载后先跑探针：

```bash
/usr/bin/bwrap --unshare-user --unshare-net --tmpfs / --ro-bind /usr/bin /usr/bin --ro-bind /usr/lib /usr/lib \
  --proc /proc --dev /dev --tmpfs /tmp /bin/true
```

非 0、超时或二进制身份变化均进入 `sandbox_unavailable`，拒绝全部 `core.exec`。不得降级。

执行骨架至少包含：

```text
--die-with-parent --new-session
--unshare-user --unshare-net --unshare-ipc --unshare-pid --unshare-uts
--tmpfs /
--ro-bind /usr/bin /usr/bin
--ro-bind /usr/lib /usr/lib          # 另按存在性提供 /usr/sbin、/usr/lib64、/usr/share
--symlink usr/bin /bin              # 或在非 usr-merge 主机只读挂载对应最小运行目录
--symlink usr/lib /lib
--proc /proc --dev /dev --tmpfs /tmp
--ro-bind <approved read root> <same path>
--bind <approved writable root> <same path>
--tmpfs + --remount-ro <protected existing directory>
--ro-bind /dev/null <protected existing file>
--chdir <approved cwd>
--clearenv + allowlisted env
```

- 宿主 `/` 永远不进入 mount namespace。只显式提供 `/usr/bin`、`/usr/lib` 等运行时子目录（不挂 `/usr/local`）、usr-merge 链接、最小 `/proc`/`/dev`、空 `/tmp` 和本 intent 获批的 roots；宿主 `/etc`、`/root`、`/home`、其他 `/tmp` 内容均不可见。
- 可写 bind 只能来自 intent 登记时策略快照里的 mount id，不能接收请求中的裸绝对路径。
- 每个已存在的硬保护路径在批准根 bind 之后挖空并重新只读；其他住户房间及 gateway/broker/客厅状态目录整体挖空。保护路径发现无法完整完成时拒绝执行。
- 网络 namespace 永远隔离。v1 不挂宿主 DNS、代理 socket 或任意网络设备。
- 超时先 TERM 子进程组，短暂宽限后 KILL；无论退出方式都回收整组并记录。
- bwrap stderr 中出现权限错误时，只能生成 `next.kind=request_writable_root`。户主把明确路径加入 `house.yaml` 并重载成功后，创建一个新 intent 在 bwrap 内重跑；旧 approval 不复用。

### v1 已知覆盖缺口

bwrap 的 writable bind 无法禁止在可写根中“新建一个原本不存在的受保护名字”。路径执行器能挡，但 shell 内仍存在此洞；已有保护路径会被 ro-bind 挖空。v1 必须在 `coverage` 和审计中标记 `protected_name_creation: not_enforced`。Landlock/openat2 组合用于 v2；在那之前不得把 shell 权限描述成完整的细粒度路径隔离。

## 9. 审批记忆

key 固定为：

```text
resident_id + NUL + action + NUL + target_digest
```

target 原料：

- fs：`root_id + NUL + normalized_relative_path`
- exec：`cwd.root_id + NUL + normalized_cwd_path + NUL + JCS(argv) + NUL + JCS(writable_root_ids)`

规则：

- `once` 仅对当前 approval 生效。
- `session` 只在网关当前 session id 内存中，重启失效。
- `always` / `never` 原子写入 `/var/lib/sameroof-gateway/policy.json`，`0600`，带创建人、时间、配置版本和精确 key；不能写通配符。
- `session|always` 只与 `decision=allow` 组合；`never` 只与 `decision=deny` 组合；`once` 两种决定都可用。其他组合拒绝，不做猜测。
- remembered allow 仍需生成成对 `asked` / `decided` 审计，`decision_source=remembered`，再进入相同的一次性消费状态机。
- 同一 run 中被拒绝的相同 key 再次请求直接 `abandoned`，不再打扰人。
- deny 优先于 allow；硬编码 deny 和 house/room ceiling 永远不能被记忆覆盖。

## 10. 审计、秘密与错误

审计库位于 `/var/lib/sameroof-gateway/gateway.db`，WAL，目录 `0700`、文件 `0600`。至少记录：时间、request/approval/run/resident、动作、摘要、策略版本、asked/decided、决定来源、执行器、bwrap 探针版本、开始/结束/退出码、coverage 和 next。

不记录：文件 content、完整 stdout/stderr、环境值、token、Authorization、`.env` 内容。对 stdout/stderr 只存 hash、字节数、截断标记和脱敏后的短摘要。常见 secret pattern 与已知 token 值在入库和投回前双重脱敏。网关必须把自己实际载入的 adapter token、客厅 service token、broker token 等加入 exact-value redaction set；客厅的键名字样脱敏只是第二道兜底，不能替代这一层。

稳定错误码至少包括：

- `GW-AUTH-DENIED`、`GW-ACTION-UNKNOWN`、`GW-PARAMS-INVALID`
- `GW-POLICY-DENIED`、`GW-APPROVAL-MISMATCH`、`GW-APPROVAL-USED`、`GW-APPROVAL-EXPIRED`
- `GW-PATH-OUTSIDE`、`GW-PATH-PROTECTED`、`GW-PATH-SYMLINK`、`GW-PATH-TYPE`
- `GW-SANDBOX-UNAVAILABLE`、`GW-SANDBOX-DENIED`、`GW-TIMEOUT`
- `GW-IDEMPOTENCY-CONFLICT`、`GW-RESULT-DELIVERY-FAILED`、`GW-FAILED-UNKNOWN`

## 11. 部署形状

- 程序：`/opt/sameroof/gateway`
- 状态：`/var/lib/sameroof-gateway`
- socket：`/run/sameroof-gateway/gateway.sock`
- 用户：`sameroof-gateway`（nologin）；组：`sameroof`
- socket `0660`，只有登记过的 adapter service users 和管理 CLI 能进组。
- adapter token 目录随 runtime directory 重建；启动器按房间生成/投递文件，网关数据库只存 token hash。room units 未拆成独立用户前，这只能鉴别协议身份，不能抵抗宿主 root 冒充；该限制必须出现在部署验收报告。
- `deploy/sameroof-gateway.service` 使用 `User=sameroof-gateway`、`Group=sameroof`、`UMask=0077`、`NoNewPrivileges=yes`、`PrivateTmp=yes`，并显式隐藏 broker/客厅状态；不能把 bwrap 所需 user namespace 一并封死。二进制入口另有 uid 0 fail-closed，避免错误 unit 静默退回 root。
- 安装脚本必须先备份旧状态、以服务用户检查 DB、跑 bwrap 探针、原子切换；失败回滚。本文不授权重启或改线上 unit。

## 12. G1 验收矩阵

至少自动化覆盖：

1. 无审批服务、错误 service token、决定流断开均不执行。
2. approval id 重放、并发双消费、digest/action/resident/request 任一错配均不执行。
3. pending 过期、执行超时、executing 中崩溃均有确定终态且不自动重放。
4. `..`、绝对路径、前缀碰撞、每层 symlink、悬空 symlink、rename 竞态、特殊文件全部拒绝。
5. 所有硬保护路径在直接文件动作中不可写；bwrap 中已存在的保护路径不可写。
6. bwrap 缺失、探针失败、启动失败时命令从未在宿主裸跑。
7. bwrap 内网络不可达；环境中没有宿主 secrets。
8. EPERM 只产生扩根建议；代码中没有 unsandboxed retry 分支。
9. once/session/always/never 与 ceiling、同 run 拒绝去重均正确。
10. 结果投递幂等、只到申请住户、以 human 车道唤醒；投递失败可重试且不重执行动作。
11. asked/decided 必须成对；审计和返回不含 token、content 或原始 secrets。
12. 返回总有 `status / coverage / next`，coverage 不夸大。

G1 自动化映射：基础状态机、锁漂移与读取边界在 `packages/gateway/test/gateway.test.js`；真实客厅投递（含 1199-byte 读取）在 `living-room-seam.test.js`；审批服务故障、四绑定错配/并发消费、过期/崩溃、路径竞态与特殊文件、真实 bwrap 主机秘密/服务状态/其他房间/网络隔离、硬保护、审计脱敏及投递不重执行在 `security-matrix.test.js`。真实 bwrap 测试不允许 skip：探针失败即测试失败。

检索员每一版按本矩阵审；G1 进入主树前由审查员复核并显式给出 ALL_CLEAR，或列明未清 P0/P1。

## 13. 写面与本轮后续

- G1 只写 `packages/gateway/*`。
- W3 按第 2、3 节补适配器与客厅接缝；客厅不直接执行。
- Y2 把第 6 节配置形状落到 schema、语义校验器和 lock。
- deploy/unit/CI/demo 不属于 Y1，由白板 GPT 按 WORKPLAN 写，审查员复核。
