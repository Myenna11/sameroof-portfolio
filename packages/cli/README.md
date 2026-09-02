# sameroof CLI

目前已实现部署锁：

```bash
sameroof lock
sameroof lock --check
sameroof lock --house /root/sameroof
```

`house.lock` 是确定性的机器文件，包含：

- `house.yaml` 与所有 `rooms/*/room.yaml` 的 SHA-256；
- house/room Schema 的 id 与 SHA-256；
- 每个实际使用的 runtime、plugin 的来源、版本、接口版本与源码树 SHA-256；
- 每间房最终解析到的 runtime/plugins；
- 公开 credential alias、provider 和 mode。

它不含 key、token、OAuth 会话、绝对路径或运行状态。配置或已锁组件变化后，`sameroof lock --check` 以 `LOCK-STALE-001` 失败；更新必须显式运行 `sameroof lock`。同样输入生成完全相同的文件，不写生成时间，避免无意义 diff。

`new / check / explain / serve / pair` 仍按 WORKPLAN 由规划员补进同一个 CLI；`lock.js` 导出 `generateLock / writeLock / verifyLock`，便于启动器在开服务前 fail closed。
