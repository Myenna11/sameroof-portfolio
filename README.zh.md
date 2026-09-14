# 同屋 · Same Roof

**多 provider agent 运行时。不同模型，同一个工作区。**

让不同厂商的 agent——Claude、GPT、GLM、Kimi、Codex——在同一个项目目录里工作。凭证隔离，沙箱执行，协作模式由你定义。

每个 agent 保留自己的原生能力。框架只管协调。

## 为什么

现在的 agent 工具都是单 provider 封闭的。Claude Code 只跑 Claude，Codex 只跑 OpenAI，DeepSeek Harness 只跑 DeepSeek。

同屋把它们放在一个工作区里：

- **凭证隔离** — broker 为每个 agent 签发短期 token，agent 之间看不到彼此的密钥
- **沙箱执行** — 基于 bwrap 的沙箱 + 审批链，fail-closed：没有沙箱就不执行
- **消息路由** — agent 通过协调器通信，委托任务、请求审核、共享结果
- **成本控制** — 按 agent 的配额、用量账本、prompt caching
- **用户定义协作** — 谁干什么由你决定。框架提供基础设施，不提供工作流

## 核心概念

**工作区** (`house.yaml`) — 项目级配置：时区、默认权限、凭证别名、通知目标。

**Agent 档案** (`rooms/<name>/room.yaml`) — agent 级配置：模型 provider、凭证、权限、运行时类型。一份档案可以跑多个实例。

**凭证 broker** — 管理多个 provider 的 API key，向 agent 签发短期不透明 token，按 agent 按天记账。

**执行网关** — 在 bwrap 沙箱里跑命令。文件读取走路径规则不起子进程。每个动作都需要审批。没有网关 = 不执行，绝不静默降级。

**协调器** — 在 agent 和人之间路由消息。管理任务板（钉、领、完成）。广播审批请求。

## Agent 协作

同屋提供渠道。怎么协作由你定义。

```yaml
# 在 agent 的系统提示或 SOUL.md 里：
# "写完代码让审查员审一下。"
# "不确定的事情委托给规划员。"
# "重复的文件扫描任务，起一个 GLM 子实例去跑。"
```

agent 可以：
- 通过协调器**给其他 agent 发消息**
- 往其他 agent 的任务板上**钉任务**来委托工作
- 对特权操作**请求审批**
- **起子实例**——任意已配置的 agent 档案都可以

不管协作模式是什么，框架保证凭证隔离和沙箱执行。

## 状态

开发中。核心基础设施（broker、gateway、协调器）已上线，118 个测试全绿。

MIT.
