# @sameroof/broker

同屋凭证数据面。住户只拿本机 Unix socket 与不透明短期 token；上游真凭证只存在 broker 的 0600 状态库和进程内存中。

## 第一版合同

- 开发默认 socket：`~/.sameroof/run/broker.sock`，权限 `0600`
- systemd socket：`/run/sameroof-broker/broker.sock`，权限 `0660`，仅 `sameroof` 本机组可连接
- auth：`Authorization: Bearer <resident token>`
- token 文件：开发默认 `~/.sameroof/run/tokens/<resident_id>`；systemd 为 `/var/lib/sameroof-broker/tokens/<resident_id>`，权限 `0600`
- API：`GET /v1/models`、`POST /v1/chat/completions`
- 可选头：`x-sameroof-purpose`、`x-sameroof-credential`
- 上游路径：`openai` 保留住户 `/v1`；`bare` 表示 base_url 已是 provider API 根并剥离 `/v1`；旧记录 `auto` 对末尾 `/v数字` 兼容止血
- 错误：401 无效/过期；403 allowlist/用途/quarantine；429 配额/限流；502 上游
- 记账：请求前预留、请求后按 provider usage 结算；不记录 prompt/response
- 第一版明确不支持 `stream: true`，避免假装对流式 usage 做了可靠结算

`GET /v1/models` 返回 token 自己的 model allowlist，不把上游全量模型目录泄露给住户。

## 管理命令

真凭证只从 `0600` 文件或 stdin 读取，不接受 `--api-key`，避免进入 shell history：

```bash
sameroof-broker cred add shared-cheap \
  --provider zhipu \
  --base-url https://open.bigmodel.cn/api/paas/v4 \
  --path-style bare \
  --key-file /run/secrets/zhipu

sameroof-broker cred list
sameroof-broker cred path-style shared-cheap bare
sameroof-broker cred rotate shared-cheap --key-file -
sameroof-broker cred revoke shared-cheap
```

给检索员签一个 12 小时 token：

```bash
sameroof-broker token issue resident_researcher_01 \
  --credential shared-cheap \
  --models glm-5.3-flash \
  --purposes interactive,heartbeat \
  --ttl 12h \
  --max-requests 100 \
  --max-tokens 200000
```

secret 只在签发时返回一次；数据库只保存 SHA-256 hash。同一住户已有 token 文件时会拒绝覆盖；只有明确加 `--replace` 才会替换文件并吊销被顶掉的旧 token。永久吊销由人执行，异常时先 quarantine：

```bash
sameroof-broker token quarantine tok_xxx
sameroof-broker token activate tok_xxx
sameroof-broker token revoke tok_xxx
sameroof-broker ledger --limit 50
```

Web Push 的 VAPID 私钥也归 broker 凭证状态，不交给客厅：

```bash
sameroof-broker push init --subject https://house.sameroof.example
sameroof-broker push status
sameroof-broker push init --subject https://house.sameroof.example --rotate
```

初始化会在 `/var/lib/sameroof-broker` 写入 0600 VAPID 凭证与客厅调用 token。`status` 和内部公钥接口都不会返回私钥；轮换必须显式使用 `--rotate`，轮换后浏览器需要重新订阅。

启动数据面：

```bash
sameroof-broker serve
```

## systemd 部署

正式服务不从 `/root` 工作树直接运行。安装器把最小运行文件复制到 root 只读的 `/opt/sameroof/broker`，服务使用无登录 shell 的 `sameroof-broker` 用户：

```bash
sudo deploy/install-broker.sh /root/sameroof
sudo systemctl enable --now sameroof-broker
systemctl show sameroof-broker -p User -p Group -p DynamicUser
systemd-analyze security sameroof-broker.service
```

状态库和真凭证在 `/var/lib/sameroof-broker`（0700），socket 在重启自动重建的 `/run/sameroof-broker`。管理命令的 `/usr/local/bin/sameroof-broker` wrapper 会降权为服务用户再打开数据库，避免 root 控制命令把状态文件所有者改回 root。现有 root 适配器通过 `/root/.sameroof/run/broker.sock` 兼容 symlink 连接；以后房间拆成独立用户时，只把对应进程加入 `sameroof` 组，不开放状态目录。

沙箱关闭 home、设备、namespace、内核与 control-group 写面，只保留 Unix socket 和上游 HTTPS 所需的地址族。这个边界防住户进程横向读取全家真 key，不声称能抵抗 VPS root 已完全失守。

## 开发

```bash
npm install
npm test
```
