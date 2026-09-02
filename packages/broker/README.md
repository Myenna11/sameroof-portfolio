# @sameroof/broker

同屋凭证数据面。住户只拿本机 Unix socket 与不透明短期 token；上游真凭证只存在 broker 的 0600 状态库和进程内存中。

## 第一版合同

- socket：`~/.sameroof/run/broker.sock`，权限 `0600`
- auth：`Authorization: Bearer <resident token>`
- token 文件：`~/.sameroof/run/tokens/<resident_id>`，权限 `0600`
- API：`GET /v1/models`、`POST /v1/chat/completions`
- 可选头：`x-sameroof-purpose`、`x-sameroof-credential`
- 错误：401 无效/过期；403 allowlist/用途/quarantine；429 配额/限流；502 上游
- 记账：请求前预留、请求后按 provider usage 结算；不记录 prompt/response
- 第一版明确不支持 `stream: true`，避免假装对流式 usage 做了可靠结算

`GET /v1/models` 返回 token 自己的 model allowlist，不把上游全量模型目录泄露给住户。

## 管理命令

真凭证只从 `0600` 文件或 stdin 读取，不接受 `--api-key`，避免进入 shell history：

```bash
sameroof-broker cred add shared-cheap \
  --provider zhipu \
  --base-url https://example.invalid/v1 \
  --key-file /run/secrets/zhipu

sameroof-broker cred list
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

secret 只在签发时返回一次；数据库只保存 SHA-256 hash。永久吊销由人执行，异常时先 quarantine：

```bash
sameroof-broker token quarantine tok_xxx
sameroof-broker token activate tok_xxx
sameroof-broker token revoke tok_xxx
sameroof-broker ledger --limit 50
```

启动数据面：

```bash
sameroof-broker serve
```

部署时应把 broker 放在独立 OS 用户下，以 systemd 沙箱限制文件访问和出站。这个 MVP 防住户进程横向偷全家 key，不声称能抵抗 VPS root 已完全失守。

## 开发

```bash
npm install
npm test
```
