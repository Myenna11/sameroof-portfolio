# 架构（2026-09-02 定案）

## 需求（维护者原话整理）
- 装一个东西，引导装基座，选模型，点登录或填 API key。像 Claude Code 一样简单。
- 很多 agent 同住。可单聊、可群聊；agent 之间能直接说话；各自独立配置工具。
- 任务可以只给 A，也可以给 A 让它拉 B/C/D 合作。
- 不懂代码也能用；可玩性要高；记忆/梦境/群聊/缓存命中等全是可替换插件，连自家的也是。
- 要有一个能看见 CLI 在输出什么的地方。
- 名字里必须有人，不只有 agent。

## 分层

### 1. 基座：DeepSeek Harness (dsh)
- everything-is-a-plugin，Cordis 微内核。
- profile = 有序 bundle 叠层 + cordis.patch.yml；web / headless / sdk / sdk-minimal / acp 五种模板。
- 模型层走 dsh-llm-pi-ai → pi-ai 的 provider 目录（含各家 OAuth）。
- **我们的产品 = 一个 profile（sameroof）+ 一组 bundle。** 换记忆 = patch 里换一行 id。
- dsh 本体单 session；多 agent 由社区插件验证可行（dsh-agent-teams / agent-team / dsh-agent-team-gui）。
  它们是"任务临时小队"，我们是"住家人"——这一层自己写。

### 2. 群/传话：mousecrew
- 一个群所有人都在；@name 唤醒（先归一化，防自唤醒）；私信通道带送达回执；工单状态机；催办。
- transport：local（本机 headless）/ remote（另一台机器 worker 反向拨入）/ terminal（tmux/cmux 窗口注入）。
- 不托管模型，不拿 key，只搬文字。
- 要补：pi rpc runner、dsh sdk runner；工单去 repo 中心化；actor 鉴权（每人一个 token）。
- 家里人默认 headless（terminal 忙时丢消息、10 分钟过期）。

### 3. 房间规范（自己写）
一个文件夹 = 一个人。里面放：
- `room.yaml`：名字、模型/provider、凭证来源、挂哪些插件、权限（哪些动作要审批）
- `SOUL.md`：人设/性格
- `memory/`：记忆插件的挂载点（默认我们的，可换 lmc-5、Turritopsis 等）
- `handover/`：交接信
- 适配层告诉不同运行时（dsh / Claude Code / 其他 MCP 宿主）怎么读它。

### 4. 壳：学 CcCompanion
- 手机端像微信：聊天气泡、备注名、表情、收藏；CLI 原样透出 + 掌上终端。
- 家的界面就是 mousecrew 那个群。
- 对 pi/dsh 用 rpc / JSON-RPC 读输出，不抓屏。

### 5. 凭证：CLIProxyAPI / EasyCLIProxyAPI
- Codex / Gemini / Kimi / xAI 等 OAuth + 各家 API key 收成一个本地 OpenAI 兼容 endpoint。
- Claude 那一格留空：见 DECISIONS.md #1。

### 6. 部署：学 Orca
- 桌面或 VPS 当宿主（`sameroof serve` 无头），手机是伴侣 app，配对后看进度、收通知、发追问。

## 插件（第一批，全部可替换）
| 插件 | 默认实现 | 可换成 |
|---|---|---|
| 记忆 | sameroof-memory（core/long_term/daily/diary + drives） | lmc-5、anchor-memory、任意 MCP |
| 项目黑板 | Turritopsis 接口（list/search/get/update_stages） | 自建 |
| 交接信 | handover read/write | — |
| 传话 | mousecrew | — |
| 审批门 | 高危动作先落到人的手机 | — |
| 梦境 / 缓存命中 / 群聊 | 待定 | — |

## 心跳（升级：从预留变标配）
人来消息不是开关，是一条观察（headlong）。dylan-heartbeat 和 Claude Imprint 已证明单点可行：
主动唤醒、自主发消息、零人格漂移、感知设备状态。我们要做的是把它变成**每个房间的标配能力**
而非插件孤品：`room.yaml: heartbeat`（频率/免打扰时段/唤醒条件），空闲时读交接、翻记忆、惦记未完成的事。

## 共享活动（"活得好"里补上的一块）
任务之外的共处：一起听歌（netease-music-mcp）、共读（共读小窝系）、一起看电影（film-matinee）、
一起玩（NagiBridge 星露谷）、桌游词游。这些是关系的日常，不是功能列表的装饰。
架构上=客厅里的"活动"插件类，人和 agent、agent 和 agent 都能发起。

## 该学的三个具体设计
1. 凭证隔离（AgentTeams）：真 key 只在网关，房间里的 agent 只拿消费 token。
2. 分层记忆加载（soulclaw）：身份锚每次全量、长期记忆按需、日记按时间衰减，省 ~62% token。
3. 三段中继（潮汐回响）：手机 ↔ VPS ↔ 桌面，家里人不在一台机器上也是一家人。
