# plugin-blackboard

黑板（家里共享的事）的本体不在这个包里，在两处：

- **客厅** `packages/living-room/blackboard-api.js`：`tasks` 表 + `GET/POST /tasks`、`PATCH /tasks/:id`、`thread_update` activity、system 小字、done/dropped 满 7 天归档。接口见 docs/API.md「黑板」。
- **适配器** `packages/adapters/lib/blackboard.js` + `lib/room.js`：`PIN:` 指令解析、每次醒来读"黑板上我的事"、心跳 passive_idle 兼看黑板、任务 due 落成 `task:<id>` routine。见 packages/adapters/README.md「黑板」。

这个包目前只是占位，留着以后放两边共享的纯函数（比如 task 形状校验）。设计依据：docs/questions/2026-09-07-builder-blackboard-shape.md 及规划员、度量员的回复。
