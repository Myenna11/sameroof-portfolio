# house

"家"的界面。壳的味道学 CcCompanion（聊天优先、CLI 原样透出）。群就是我们自己的客厅（docs/LIVING_ROOM.md）。

## 壳 v2（2026-09-12，实现员）

设计系统三层，改样式先改系统，别在页面里随手写值：

- **token**：间距阶梯 `--s1..s8`（4 的倍数）、字阶、语义色（`--surface/--ink-2/--accent/--danger…`）、圆角 `--r-*`、阴影 `--sh-*`、动效 `--dur/--ease`。全部在 `<style>` 顶部 `:root`。
- **组件**：按钮、卡片、pill、骨架屏 `.sk`、进度条 `.gbar`、图标 `.ic`（内联 lucide SVG，`svgIc()` / `data-ic`）。emoji 只留给住户头像和身份，不当图标用。
- **布局**：桌面左栏 + 内容栏（≤820px 居中）；手机底栏。切换视图有过渡，尊重 `prefers-reduced-motion`。

## 无构建，纯单文件

`index.html` 就是全部：style + 五个 view + 一个 script。不引框架、不引 webfont。

## 视觉回归 / 验收

`dev-shots.js`：零依赖 CDP 截图脚本，假数据 fetch 桩（不碰真服务器、不需要 token），before=git HEAD、after=工作区，九个页面两种宽度。

```bash
node apps/house/dev-shots.js     # 截图在 tmp/shots-v2/（可用 SHOTS_OUT 改）
```

改壳之前之后各跑一次，肉眼对比。EDGE 环境变量可换浏览器路径。
