# 同屋 · Same Roof

**多模型 Agent 协作运行时与可视化工作台。**

[English](README.md) · [架构](docs/ARCHITECTURE.md) ·
[设计决策](docs/DESIGN_DECISIONS.md) · [历史与贡献说明](PROVENANCE.md)

项目将消息协调、模型凭证访问和工具执行拆成独立组件，支持多个 Agent
在一个工作区内协作，让人能够查看任务、审批和已经记录的工作过程。
当前定位是**单机、单租户、自托管原型**，不是多租户生产平台。

## 核心能力

- Coordinator：HTTP/SSE 消息、私聊、任务、审批投递和 SQLite 持久化收件箱。
- Broker：为 broker-direct 运行时提供短期、限模型／凭证／用途的访问令牌，记录用量。
- Gateway：策略判断、审批绑定、bubblewrap 命令沙箱；不可用时拒绝执行，不静默降级。
- Adapter：事件唤醒、会话交接、只读子任务循环、本地 mailbox 和中断恢复。
- 可靠投递：持久化 outbox、幂等发布、确认发布后 ACK；回执丢失和重启有故障测试。
- Web：群聊、私聊、任务板、审批、运行记录和每个 Agent 的用量面板。

原生 CLI 的凭证和工具不自动受 Broker／Gateway 管理。模型和工具执行不具备
端到端 exactly-once 保证。工作台也不声称展示完整终端或隐藏思考链。

## 无凭证演示

需要 Node.js 22+；完整测试和 Gateway 需要 Linux、bubblewrap 及可用的用户命名空间。

```sh
npm ci
node examples/code-review/demo.js
SAMEROOF_ROOT="$PWD" node apps/roof/server.cjs
```

网页入口为 `http://127.0.0.1:17930/`。页面默认是虚构数据演示。
代码审查示例使用真实协调器、适配器和 Broker，但模型上游为 mock，且不启动 Gateway。
根目录也只是 mock 配置，不含实际家庭成员、账号或部署授权。

## 验证

```sh
node packages/cli/index.js check
node packages/cli/index.js lock --check
npm test
node --test apps/roof/*.test.cjs
```

CI 还包含独立工作区启动、派发、回复和退出的冒烟测试。测试数量以实际输出为准，
原私有仓库的 CI 记录不能充当本展示版新提交的通过记录。

主要界面是 `apps/roof`；`apps/console` 是管理入口；`apps/house` 是兼容保留的早期界面。
详细目录、实现边界、部署注意事项见 [英文主页](README.md)。

本版本保留了脱敏后的真实开发历史，没有伪造提交次数，也没有将 AI 协作者的
贡献改署给一个人。MIT 许可证和历史处理说明见 [PROVENANCE.md](PROVENANCE.md)。
