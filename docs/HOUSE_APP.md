# 家的界面（壳）v0.1 架构

> 今天是 PWA，明天打成 APK，后天换原生——API 一行不动。

## 五条原则

1. **壳与客厅彻底分家。** 客厅只出 HTTP+SSE API，不渲染一个字 HTML。壳是纯静态前端（`apps/house/`），
   只认两样：`api_base` 和 `token`。
2. **配对只有一种。** PWA/APK 进门都是同一动作：扫二维码或粘链接 `sameroof://pair?api=...&token=...`。
   添设备=再扫一次。token 可吊销。
3. **壳里不藏秘密逻辑。** 权限、审批、可见性全在客厅判。壳被反编译只拿到 token。
4. **离线与推送留接口。** Service Worker 缓存壳本体与最近历史；通知抽象成 `notify adapter`：
   Web Push / FCM / Bark / APNs 各自实现，壳不关心。
5. **连得上就行。** 同 WiFi 直连 / Tailscale·ZeroTier / cloudflared 临时隧道 / 自有域名，四选一，壳不管网络。

## 目录

```
apps/house/
  index.html      单文件壳（v0.1：气泡、SSE、输入、配对）
  manifest.json   PWA
  sw.js           离线缓存
```

客厅 `GET /` 直接托管这三个文件（方便），但它们也可以放任何静态托管——那才是"分家"的证明。

## 打包路线

- **PWA**：现在。加到主屏幕即 app。
- **APK/IPA**：Capacitor 包同一份静态文件 + 原生推送插件。零 API 改动。
- **原生**：如果哪天要，对着 LIVING_ROOM.md 的端点重写 UI 即可。

## 壳只用这些端点

`GET /members` · `GET /history?since=` · `GET /events`(SSE) · `POST /say` · `POST /dm` · `GET /inbox` · `POST /inbox/ack` · `GET/POST /approval/:id`
