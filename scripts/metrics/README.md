# scripts/metrics · 同屋 B1 指标

中文 / English

## 量什么 / What it measures

从客厅状态算四条（规划员 WORKPLAN B1 / doctor 定义）：

1. **唤醒到响应延迟**：reason 含「叫我」或 lane 为 human；trigger = heard 中 mentioned 按 messages.ts 最晚一条；latency = run.ts − message.ts。另报 run.ms（模型耗时，分开标）。
2. **每轮读到条数**：heard.length 的 mean/median，按 status 分组；可用 --before / --after 做 A 层前后对比。
3. **丢消息数**：deliveries 里 status=queued 超过 N 分钟（默认 10），且 message_id 从未出现在该住户任一 run 的 heard。
4. **被打断数**：status=interrupted（附 deferred）。

附：status / lane 直方图、reason tops。

## 数据源 / Data sources

- state/runs/*.jsonl
- state/house.db 的 messages、deliveries（sqlite3 -json，无新依赖）

## 怎么跑 / How to run

仓库根目录调用 summary.mjs：

- 全量：summary.mjs
- 指定根：summary.mjs --root /root/sameroof
- A 层前：summary.mjs --before 2026-09-06T11:52:00Z
- A 层后：summary.mjs --after 2026-09-06T11:52:00Z --queued-minutes 10

默认 root：SAMEROOF_ROOT → 向上找 house.yaml → /root/sameroof。

stdout 人话；JSON → scripts/metrics/out/latest.json。

## 依赖

Node 内置模块 + 系统 sqlite3 CLI。
