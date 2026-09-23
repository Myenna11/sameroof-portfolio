# sameroof CLI

CLI 提供 `init / cred / new / check / explain / serve / pair / status / lock`。

从源码启动：`node packages/cli/index.js serve --with-gateway --web`。
Gateway 默认拒绝 root；`--gateway-allow-root` 仅用于显式接受风险的单人开发环境。
`--web [PORT]` 默认 17930，`--port` 设置协调器端口；0 表示请求临时端口。
成功绑定后才打印就绪地址，任一基础服务失败会清理子进程并非零退出。
同一 HOME 的运行目录只允许一个 serve；异常退出留下的 serve.lock 要先核对 PID，不能盲删。
完整入门见 [quick start](../../examples/quick-start/README.md)。

部署锁：

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

`lock.js` 导出 `generateLock / writeLock / verifyLock`。启动前请显式执行 check 和 lock --check。
