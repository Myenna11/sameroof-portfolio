# @sameroof/gateway

能力执行网关，严格按 `docs/GATEWAY.md` 的执行侧合同工作：适配器只登记不可变 intent，客厅只给权威审批结果，只有网关会碰文件或启动 bwrap。

## v1 入口

- Unix socket：`POST /v1/intents`，Bearer token 必须绑定住户，`Idempotency-Key` 必须等于 `request_id`。
- `GET /v1/intents/:request_id`：只允许申请住户查看，不回显原始 params。
- 文件动作使用以 root fd 为锚的逐段 `O_NOFOLLOW` 检查；拒绝 `..`、链接、特殊文件、硬保护路径和其他住户房间。
- shell 只走 bwrap；启动时和执行前均探测 user/network namespace，失败直接返回 `GW-SANDBOX-UNAVAILABLE`，没有裸跑分支。
- 网关轮询客厅持久化决定流，事务消费 approval，并将结果幂等投回住户 inbox。

生产入口：

```sh
SAMEROOF_ROOT=/path/to/house node packages/gateway/server.js
```

默认状态在 `<house>/.sameroof/state/gateway`，socket/token 在 `<house>/.sameroof/run/gateway`。部署时应显式改为 `docs/GATEWAY.md` 约定的 `/var/lib/sameroof-gateway` 与 `/run/sameroof-gateway`，并以独立 OS 用户运行。

## 安全边界

- 新 intent 要求 `house.lock` 与其列出的配置文件摘要一致；测试夹具可显式传 `lockRequired:false`。
- `core.exec` 的网络 namespace 永远隔离，环境从空白开始，只接受 `LANG/LC_ALL/TZ/NODE_ENV`。
- 已存在的 `.git/hooks`、`.git/config`、`.env*`、`house.yaml`、`house.lock`、`.sameroof` 和其他住户房间会在可写 bind 后重新只读挂载。
- bwrap v1 无法阻止在可写根中新建尚不存在的受保护名字，因此结果的 coverage 明示 `protected_name_creation:not_enforced`；不把它描述成完整细粒度隔离。

测试：`npm test -w @sameroof/gateway`。

## 部署（V2-6A）

```sh
sh deploy/install-gateway.sh            # 建 sameroof-gateway 用户、装 /opt/sameroof/gateway、unit、控制面命令
sh deploy/gateway-service-token.sh      # 客厅 ↔ 网关 service token，同一串写两处（--rotate 换）
systemctl enable --now sameroof-gateway
sameroof-gateway token issue <resident_id>   # adapter token 落到 /run/sameroof-gateway/tokens/<resident_id>（0640，room 进程读）
```

unit 把 `/root/sameroof` 按路径只读绑进 `/srv/sameroof`（rooms/ 可写），`RuntimeDirectoryPreserve=yes` 让 adapter token 挺过重启。
客厅地址走 `SAMEROOF_LIVING_ROOM_PORT`（默认 8790）。新 intent 要过 `house.lock`，房间有增减先 `sameroof lock`。
