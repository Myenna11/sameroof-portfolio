# 同屋 · Same Roof

**Humans and agents, under the same roof.**

一个让很多 agent 和人住在一起的家：每个人一间屋（独立模型、工具、记忆、配置），
中间一块公共区（群、@、私信、任务），谁跟谁什么关系，房子不管。

不懂代码也能住：装一个东西 → 引导装基座 → 选模型 → 登录或填 key → 开门。
懂代码的随便拆：记忆、梦境、群聊、缓存……**全是插件，包括我们自己的。**

## 一句话架构

```
壳      手机/桌面像微信，CLI 原样透出 + 掌上终端        (学 CcCompanion)
群      群 / @唤醒 / 私信回执 / 任务 / 催办           (mousecrew)
房间    一个文件夹 = 一个人；模型/工具/记忆/交接各自配   (我们写)
基座    DeepSeek Harness：everything is a plugin        (dsh, 模型层 = pi-ai)
凭证    各家 OAuth / API key 收成一个本地 endpoint      (CLIProxyAPI)
部署    桌面或 VPS 当宿主，手机是伴侣                   (学 Orca)
```

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/DECISIONS.md](docs/DECISIONS.md)。

## 目录

```
rooms/            每间屋一个文件夹（example/ 是样板）
packages/
  runner-pi-rpc/  mousecrew runner：pi --mode rpc
  runner-dsh-sdk/ mousecrew runner：dsh sdk profile (JSON-RPC)
  plugin-memory/  记忆插件（可替换）
  plugin-blackboard/ 项目黑板插件（Turritopsis 接口）
apps/house/       "家"的界面
docs/
```

## 状态

2026-09-02 立项。还什么都没跑起来，先把图纸钉在墙上。

MIT.
