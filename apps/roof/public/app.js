import { makeDemo, demoEvents, demoTerminal } from "./demo.js";
const $ = (s) => document.querySelector(s);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const paths = {
  home: "M3 10 12 3l9 7M5 9v12h14V9M9 21v-7h6v7",
  chat: "M21 11a8 8 0 0 1-8 8H5l-3 3V11a8 8 0 0 1 8-8h3a8 8 0 0 1 8 8Z",
  task: "M9 5h10v16H5V5h4m0-3h6v5H9V2m-1 11 2 2 5-5",
  work: "m5 7 5 5-5 5m8 0h6M3 3h18v18H3Z",
  memory:
    "M12 4c-3-2-7-2-10-1v17c3-1 7-1 10 1m0-17c3-2 7-2 10-1v17c-3-1-7-1-10 1V4",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8m0-6v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1",
  plus: "M12 4v16M4 12h16",
  arrow: "M5 12h14m-6-6 6 6-6 6",
  send: "m3 10 18-7-7 18-3-8-8-3Zm8 3 10-10",
  search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12 6 6",
  chevron: "m9 5 7 7-7 7",
  back: "m15 5-7 7 7 7",
  close: "m6 6 12 12M6 18 18 6",
  check: "m4 12 5 5L20 6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  refresh:
    "M20 7V2m0 5h-5M4 17v5m0-5h5M4 8a8 8 0 0 1 13-4l3 3M4 17l3 3a8 8 0 0 0 13-4",
  quota: "m13 2-8 12h6l-1 8 9-13h-7l1-7",
  reply: "m9 5-6 6 6 6m-6-6h10a7 7 0 0 1 7 7",
  download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
  lock: "M6 10V7a6 6 0 0 1 12 0v3M4 10h16v12H4z",
  leaf: "M20 3C6 1 1 11 7 17c6 6 15-1 13-14ZM4 21 16 9",
};
const icon = (name, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.chat}"/></svg>`;
const labels = {
  home: "门厅",
  chat: "客厅",
  tasks: "黑板",
  work: "工作台",
  memory: "记忆",
};
const stateNames = {
  open: "待开始",
  doing: "进行中",
  blocked: "等一等",
  done: "已完成",
  dropped: "已放下",
  said: "已回复",
  silent: "静默",
  ok: "已完成",
  error: "出错",
  interrupted: "已中断",
  timeout: "已超时",
};
const state = {
  ...makeDemo(),
  demo: true,
  page: "chat",
  room: null,
  reply: null,
  filter: "all",
  query: "",
  token: sessionStorage.getItem("roof-token") || "",
  workResident: null,
  workTab: "events",
  work: null,
  memoryResident: null,
  errors: {},
  drafts: {},
  generation: 0,
};
let streamController, refreshTimer, workPoll, toastTimer;
const member = (id) =>
  state.members.find((m) => m.id === id) || {
    id,
    name: id === "house" ? "房子" : "住户",
  };
const colors = ["sage", "ochre", "lilac", "rose", "blue"];
const tone = (id) =>
  member(id).color ||
  colors[
    Math.max(
      0,
      state.members.findIndex((m) => m.id === id),
    ) % colors.length
  ];
const avatar = (m, size = "") =>
  `<span class="avatar ${tone(m.id)} ${size}">${esc(m.name?.slice(0, 1) || "屋")}<i class="presence ${m.online ? "online" : ""}"></i></span>`;
const time = (ts) =>
  ts && Number.isFinite(Date.parse(ts))
    ? new Date(ts).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
const date = (ts) =>
  ts && Number.isFinite(Date.parse(ts))
    ? new Date(ts).toLocaleDateString("zh-CN", {
        month: "long",
        day: "numeric",
      })
    : "暂无时间";
const empty = (title, note) =>
  `<div class="empty">${icon("leaf", 34)}<h3>${esc(title)}</h3><p>${esc(note)}</p></div>`;
const errorFor = (key) =>
  state.errors[key]
    ? `<div class="notice error">${esc(state.errors[key])} <button data-action="refresh">重试</button></div>`
    : "";
const activeTasks = () =>
  state.tasks.filter((t) => ["open", "doing", "blocked"].includes(t.state));
function toast(msg) {
  $("#toast").textContent = msg;
  $("#toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 4200);
}
async function api(route, options = {}) {
  const r = await fetch(new URL("api" + route, location.href.split("#")[0]), {
    ...options,
    headers: {
      Authorization: "Bearer " + state.token,
      "Content-Type": "application/json",
      ...options.headers,
    },
    signal: options.signal || AbortSignal.timeout(24000),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error?.message || "请求失败，请重试。");
  return body;
}
function saveDraft() {
  const el = $("#compose");
  if (el) state.drafts[state.room || "public"] = el.value;
}
function render(preserveDraft = true) {
  if (preserveDraft) saveDraft();
  const title = state.room ? member(state.room).name : labels[state.page];
  $("#app").innerHTML =
    `<aside class="sidebar"><a class="brand" href="#chat"><img src="./icon.svg" alt="同屋"/><span>同屋<small>SAME ROOF</small></span></a><div class="side-label">一间有人住的房子</div><nav>${Object.entries(
      labels,
    )
      .map(
        ([key, text]) =>
          `<button class="nav-item ${state.page === key ? "active" : ""}" data-page="${key}">${icon({ tasks: "task", work: "work", memory: "memory", chat: "chat", home: "home" }[key])}<span>${text}</span>${key === "tasks" && activeTasks().length ? `<b>${activeTasks().length}</b>` : ""}</button>`,
      )
      .join(
        "",
      )}</nav><div class="residents"><div class="side-label">住在这里 <span>${state.members.length}</span></div>${state.members
      .filter((m) => m.id !== state.me?.id)
      .map(
        (m) =>
          `<button class="resident ${state.room === m.id ? "selected" : ""}" data-room="${esc(m.id)}">${avatar(m)}<span>${esc(m.name)}<small>${m.online ? "在家" : "暂时离开"}</small></span>${icon("chevron", 14)}</button>`,
      )
      .join(
        "",
      )}</div><div class="side-bottom"><div class="little-house">${icon("sun", 26)}<p>灯亮着，<br/>就有人在等你。</p></div><button class="user" data-action="connect">${avatar(state.me || { name: "访客", id: "visitor" })}<span>${esc(state.me?.name || "访客")}<small>${state.demo ? "演示中的家" : "已连接房子"}</small></span>${icon("more")}</button></div></aside>
  <div class="main-shell"><header class="topbar"><div class="breadcrumb"><span>Same Roof</span><i>/</i><strong>${esc(title)}</strong></div><div class="top-actions"><span class="connection ${state.demo ? "demo" : ""}"><i></i>${state.demo ? "演示模式" : "已连接"}</span><button class="icon-btn" data-action="quota" aria-label="查看额度">${icon("quota")}</button><button class="connect-btn" data-action="connect">${state.demo ? "连接我的房子" : "连接设置"}${icon("arrow", 16)}</button></div></header><div class="content ${state.page === "chat" ? "chat-layout" : state.page === "work" ? "work-layout" : "page-layout"}">${state.page === "chat" ? chatPage() : state.page === "home" ? homePage() : state.page === "tasks" ? tasksPage() : state.page === "memory" ? memoryPage() : workPage()}</div></div>
  <nav class="mobile-nav">${Object.entries(labels)
    .map(
      ([key, text]) =>
        `<button class="${state.page === key ? "active" : ""}" data-page="${key}">${icon({ tasks: "task", work: "work", memory: "memory", chat: "chat", home: "home" }[key])}<span>${text}</span></button>`,
    )
    .join("")}</nav>`;
  const compose = $("#compose");
  if (compose) compose.value = state.drafts[state.room || "public"] || "";
  bind();
}
function chatPage() {
  const m = state.room ? member(state.room) : null;
  return `<section class="conversation"><div class="conversation-heading"><div class="eyebrow">${m ? "A ROOM OF ONE’S OWN" : "THE LIVING ROOM"}</div><div class="heading-line"><h1>${m ? esc(m.name) + "的房间" : "坐下来，聊一会儿。"}</h1><button class="icon-btn" data-action="search" aria-label="筛选消息">${icon("search")}</button></div><div class="subheading">${m ? `${esc(m.model?.id || "家人")} · ${m.online ? "此刻在家" : "消息会留在房间里"}` : `${state.members.filter((m) => m.online).length} 位住户在家 <span class="dot-sep">·</span> 想法、近况，还有一起做的事。`}</div></div>
 <button class="task-ribbon" data-page="tasks"><span class="task-ribbon-icon">${icon("task")}</span><span><strong>${activeTasks().length ? "有 " + activeTasks().length + " 件事，等我们一起完成" : "今天的黑板"}</strong><small>${esc(activeTasks()[0]?.title || "把心里惦记的事，轻轻钉在这里。")}</small></span>${icon("chevron", 17)}</button>
 ${state.query !== "" ? `<div class="query-label">正在筛选：${esc(state.query)} <button data-action="clear-search">清除</button></div>` : ""}${errorFor("messages")}
 <div class="messages" id="messages" aria-live="polite">${messagesHTML()}</div><div class="composer-wrap">${state.reply ? `<div class="reply-bar">${icon("reply", 16)} 回复 ${esc(member(state.reply.from_id).name)}：${esc(state.reply.text.slice(0, 60))}<button data-action="cancel-reply" aria-label="取消回复">${icon("close", 16)}</button></div>` : ""}<div class="composer-tools"><button data-action="new-task">${icon("plus", 16)} 钉一件事</button><button data-page="work">${icon("work", 16)} 看看在忙什么</button><button data-action="approvals">${icon("lock", 16)} 待确认 ${state.approvals.filter((a) => a.status === "pending").length || ""}</button></div><form id="compose-form" class="composer"><textarea id="compose" rows="2" maxlength="8000" placeholder="${m ? "对" + esc(m.name) + "说点什么…" : "在客厅说点什么…"}" aria-label="消息内容"></textarea><button type="submit" class="send" aria-label="发送消息">${icon("send", 22)}</button></form><div class="composer-foot"><span>${state.demo ? "演示消息只留在当前页面" : "消息会送到 " + (m ? esc(m.name) + " 的房间" : "客厅")}</span><span>Enter 发送 · Shift + Enter 换行</span></div></div></section>${roomAside(m)}`;
}
function messagesHTML() {
  const messages = (state.room ? state.dm || [] : state.messages).filter(
    (m) =>
      !state.query || m.text?.toLowerCase().includes(state.query.toLowerCase()),
  );
  if (!messages.length)
    return empty(
      state.query ? "没有找到这句话" : "这里留着一个位置",
      state.query ? "换一个关键词试试。" : "从一句问候开始吧。",
    );
  return `<div class="day-divider"><span>${state.demo ? "今天 · 演示对话" : date(messages[0].ts)}</span></div>${messages
    .map((m) => {
      const who = member(m.from_id);
      const mine = m.from_id === state.me?.id;
      const reply = m.reply_to
        ? messages.find((x) => x.id === m.reply_to)
        : null;
      if (m.kind === "system")
        return `<div class="system-message">${icon("leaf", 13)} ${esc(m.text)}</div>`;
      return `<article class="message ${mine ? "mine" : ""}">${avatar(who)}<div class="message-content"><div class="message-meta"><strong>${esc(who.name)}</strong><span>${esc(who.model?.id || (mine ? "家人" : ""))}</span><time>${time(m.ts)}</time><button data-reply="${esc(m.id)}" aria-label="回复 ${esc(who.name)}">${icon("reply", 14)}</button></div><div class="bubble ${tone(who.id)}">${reply ? `<div class="quote">${icon("reply", 14)} ${esc(member(reply.from_id).name)}：${esc(reply.text.slice(0, 80))}</div>` : ""}<div class="message-text">${esc(m.text)}</div></div>${m.meta?.demo_run ? `<button class="run-card" data-page="work"><span class="run-icon">${icon("work", 19)}</span><span><small>演示运行 · 已完成</small><strong>检查小屋的交互和显示</strong></span>${icon("arrow", 17)}</button>` : ""}</div></article>`;
    })
    .join("")}`;
}
function roomAside(m) {
  return `<aside class="right-panel"><div class="aside-kicker">${m ? "这间房的主人" : "AROUND THE HOUSE"}</div>${m ? `<div class="room-portrait">${avatar(m, "large")}<h2>${esc(m.name)}</h2><p>${esc(m.model?.id || "一起生活的人")}</p><button class="soft-btn" data-action="resident-work" data-id="${esc(m.id)}">${icon("work", 16)} 进入工作台</button></div>` : `<div class="house-art" aria-hidden="true"><div class="art-sun"></div><div class="art-roof"></div><div class="art-house"><i></i><i></i><i></i></div><div class="art-plant"><b></b><b></b></div><span>有人在家，就是好天气。</span></div>`}<div class="aside-section"><div class="section-label">此刻在家 <small>${state.members.filter((x) => x.online).length}</small></div>${state.members
    .filter((x) => x.species !== "human")
    .slice(0, 5)
    .map(
      (x) =>
        `<button class="presence-row" data-room="${esc(x.id)}">${avatar(x)}<span><strong>${esc(x.name)}</strong><small>${esc(x.mood || x.model?.id || "自己的节奏")}</small></span></button>`,
    )
    .join(
      "",
    )}</div><div class="aside-section"><div class="section-label">刚刚发生 ${icon("leaf", 16)}</div>${
    state.activity
      .slice(0, 3)
      .map(
        (a) =>
          `<div class="activity-item"><i></i><div><span>${esc(a.text)}</span><small>${time(a.ts)}</small></div></div>`,
      )
      .join("") || '<p class="muted">还没有新的活动。</p>'
  }</div><button class="quota-teaser" data-action="quota"><span>${icon("quota", 18)} 住户的电量</span><small>看看大家还有多少余量 ${icon("arrow", 14)}</small></button><div class="aside-footer">同一屋檐，各自生长。<br/><span>SAME ROOF, DIFFERENT WORLDS.</span></div></aside>`;
}
function homePage() {
  return `<section class="full-page"><div class="eyebrow">A PLACE TO COME BACK TO</div><h1>${state.demo ? "欢迎来到演示小屋。" : "欢迎回家，" + esc(state.me?.name || "家人") + "。"}</h1><p class="page-intro">推开一扇门，就能遇见彼此。</p><div class="home-grid">${state.members.map((m, i) => `<button class="home-room ${tone(m.id)}" data-room="${esc(m.id)}"><div class="room-top">${avatar(m, "large")}<span class="room-number">ROOM 0${i + 1}</span></div><h2>${esc(m.name)}</h2><p>${esc(m.mood || m.model?.id || "把日子过成自己的样子。")}</p><div class="room-bottom"><span>${m.online ? "● 在家" : "○ 暂时离开"}</span>${icon("arrow")}</div></button>`).join("")}<button class="home-living" data-page="chat"><div><div class="eyebrow">OUR COMMON GROUND</div><h2>客厅的灯，<br/>一直为你亮着。</h2><p>${state.messages.length} 条近况 · ${activeTasks().length} 件共同的事</p></div>${icon("chat", 58)}</button></div><div class="home-bottom"><span>${icon("sun")} ${new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}</span><span>${state.demo ? "演示角色均为虚构" : "与真实的房子保持连接"}</span></div></section>`;
}
function tasksPage() {
  const list = state.tasks.filter(
    (t) => state.filter === "all" || t.state === state.filter,
  );
  return `<section class="full-page"><div class="eyebrow">THINGS WE CARE ABOUT</div><div class="heading-line"><h1>一起，把事情做好。</h1><button class="primary" data-action="new-task">${icon("plus", 17)} 钉一件事</button></div><p class="page-intro">有人接住想法，有人把它慢慢变成真的。</p><div class="filter-tabs">${[
    ["all", "全部"],
    ["open", "待开始"],
    ["doing", "进行中"],
    ["blocked", "等一等"],
    ["done", "已完成"],
  ]
    .map(
      ([k, v]) =>
        `<button data-filter="${k}" class="${state.filter === k ? "active" : ""}">${v}</button>`,
    )
    .join(
      "",
    )}</div>${errorFor("tasks")}<div class="task-grid">${list.map((t) => `<button class="task-card ${tone(t.owner_id)}" data-task="${esc(t.id)}"><div class="task-card-head"><span class="status ${esc(t.state)}">${esc(stateNames[t.state] || t.state)}</span>${icon("more", 18)}</div><h2>${esc(t.title)}</h2><p>${esc(t.notes || t.result || "等待下一段进展。")}</p><div class="task-card-foot">${avatar(member(t.owner_id))}<strong>${esc(t.owner)}</strong><small>${date(t.updated_ts || t.created_ts)}</small></div></button>`).join("") || empty("黑板上空空的", "把下一件想做的事钉上来。")}</div></section>`;
}
function memoryPage() {
  const who =
    state.memoryResident ||
    state.members.find((m) => m.species !== "human")?.id;
  return `<section class="full-page"><div class="eyebrow">LITTLE THINGS, LONG REMEMBERED</div><h1>有些话，值得留下。</h1><p class="page-intro">约定、偏好，以及一起走过的日子。</p><div class="filter-tabs">${state.members
    .filter((m) => m.species !== "human")
    .map(
      (m) =>
        `<button data-memory="${esc(m.id)}" class="${who === m.id ? "active" : ""}">${esc(m.name)}</button>`,
    )
    .join(
      "",
    )}</div>${errorFor("memory")}<div class="memory-grid">${state.memory.map((m, i) => `<article class="memory-note ${colors[i % 3]}"><div class="note-pin"></div><small>${esc((m.tags || []).join(" · ") || m.source || "记忆")}</small><p>${esc(m.content)}</p><footer>${date(m.ts)}<span>${m.review === "approved" ? "已确认" : m.review === "under_review" ? "待确认" : esc(m.review || "已记录")}</span></footer></article>`).join("") || empty("这页还没写满", "该住户还没有可展示的记忆。")}</div></section>`;
}
function workPage() {
  const people = state.members.filter((m) => m.species !== "human");
  const who = state.workResident || people[0]?.id;
  const m = member(who);
  return `<section class="workbench"><div class="work-heading"><div><div class="eyebrow">BEHIND THE SCENES</div><h1>${esc(m.name)}的工作台<span class="work-live">${state.demo ? "DEMO" : "READ ONLY"}</span></h1><p class="page-intro">每一步，都有来处。</p></div><button class="soft-btn" data-action="export">${icon("download", 16)} 导出当前记录</button></div><div class="work-body"><aside class="work-sidebar"><div class="side-label">住户</div>${people.map((m) => `<button class="work-resident ${who === m.id ? "active" : ""}" data-work="${esc(m.id)}">${avatar(m)}<span>${esc(m.name)}<small>${esc(m.runtime || m.model?.id || "住户")}</small></span></button>`).join("")}<div class="side-label">最近运行</div>${
    state.runs
      .filter((r) => r.resident_id === who)
      .slice(0, 6)
      .map(
        (r) =>
          `<div class="run-list-item"><span class="status ${r.status === "error" ? "blocked" : "done"}">${esc(stateNames[r.status] || r.status || "已记录")}</span><p>${esc(r.reason || r.lane || "住户唤醒")}</p><small>${time(r.ts)} · ${r.ms != null ? (r.ms / 1000).toFixed(1) + "s" : "耗时未记录"}</small></div>`,
      )
      .join("") || '<p class="muted small">还没有运行记录。</p>'
  }</aside><div class="work-main"><div class="work-tabs">${[
    ["events", "过程"],
    ["terminal", "原始终端"],
    ["raw", "原始记录"],
    ["subruns", "子任务"],
  ]
    .map(
      ([k, v]) =>
        `<button data-tab="${k}" class="${state.workTab === k ? "active" : ""}">${v}</button>`,
    )
    .join(
      "",
    )}<button class="icon-btn refresh-work" data-action="refresh-work" aria-label="刷新工作记录">${icon("refresh", 16)}</button></div><div id="work-content">${workContent()}</div><footer class="work-foot">${icon("lock", 13)} 只读 · 敏感字段脱敏 · 每 8 秒刷新 <span>${state.demo ? "演示数据" : "不提供远程 shell 输入"}</span></footer></div></div></section>`;
}
function workContent() {
  const w = state.work;
  if (!w) return '<div class="loading">正在打开工作记录…</div>';
  if (w.error) return empty("暂时读不到工作记录", w.error);
  if (state.workTab === "terminal")
    return `<div class="terminal-toolbar"><span><i></i><i></i><i></i></span><span>STDOUT / STDERR · READ ONLY</span></div><pre class="terminal" tabindex="0">${esc(w.raw || "当前没有日志。")}</pre><div class="source-note">${esc(w.source)} · ${esc(w.note || "")}</div>`;
  if (state.workTab === "raw")
    return `<div class="terminal-toolbar"><span>JSONL · 持久化记录</span><span>${w.truncated ? "尾部节选" : "已读取范围"}</span></div><pre class="terminal raw" tabindex="0">${esc((w.events || []).map((e) => JSON.stringify(e, null, 2)).join("\n\n") || "当前没有记录。")}</pre><div class="source-note">${esc(w.note)}</div>`;
  if (state.workTab === "subruns")
    return `<div class="event-list">${(w.items || []).map((item) => `<details class="subrun" open><summary>${icon("work", 17)} ${esc(item.events.find((e) => e.ev === "task")?.task || item.id)} <span>${item.events.length} 个事件</span></summary>${eventsHTML(item.events)}${item.truncated ? '<p class="notice">大文件，仅展示尾部记录。</p>' : ""}</details>`).join("") || empty("没有正在展开的子任务", "住户派出子任务后，这里会留下调用与结果。")}<div class="source-note">${esc(w.note)}</div></div>`;
  return `<div class="event-list">${eventsHTML(w.events || [])}${!w.events?.length ? empty("这一班还没有留下记录", w.note || "可切换到原始终端，查看适配器日志。") : ""}<div class="source-note">${esc(w.source)} · ${esc(w.note || "")}${w.truncated ? " · 仅显示文件尾部" : ""}</div></div>`;
}
function eventsHTML(events) {
  return events
    .map((e, i) => {
      const kind = e.ev || e.op || e.role || "record";
      const title =
        {
          task: "收到任务",
          summary: "思考摘要 · 演示",
          model_call: "调用模型",
          model_reply: "模型回复 · 已记录预览",
          tool_register: "工具调用",
          tool_done: "工具结果",
          tool_error: "工具失败",
          tool_refused: "工具被拒绝",
          model_error: "模型调用失败",
          end: "运行结束",
          start: "开始运行",
          msg: e.role === "assistant" ? "住户回复" : "输入消息",
          retract: "撤回上一条输入",
        }[kind] || kind;
      const body =
        e.text ||
        e.task ||
        e.content ||
        e.preview ||
        e.stdout ||
        e.message ||
        e.reason;
      return `<article class="event"><div class="event-dot ${/error|refused/.test(kind) ? "failed" : ""}">${icon(/tool/.test(kind) ? "work" : kind === "end" ? "check" : kind === "summary" ? "sun" : "chat", 15)}</div><div class="event-body"><div class="event-head"><strong>${esc(title)}</strong><time>${time(e.ts)}</time></div>${e.action ? `<code>${esc(e.action)}</code>` : ""}${body ? `<div class="event-text">${esc(typeof body === "string" ? body : JSON.stringify(body, null, 2))}</div>` : ""}${e.exit_code != null ? `<span class="status ${e.exit_code === 0 ? "done" : "blocked"}">exit ${e.exit_code}</span>` : ""}<details><summary>查看记录 ${String(i + 1).padStart(2, "0")}</summary><pre>${esc(JSON.stringify(e, null, 2))}</pre></details></div></article>`;
    })
    .join("");
}
function modal(title, body) {
  $("#overlay").innerHTML =
    `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header><h2>${esc(title)}</h2><button data-action="close-modal" class="icon-btn" aria-label="关闭">${icon("close")}</button></header><div class="modal-body">${body}</div></section></div>`;
  bind($("#overlay"));
  $("#overlay").querySelector("input,textarea,select,button")?.focus();
}
function connectDialog() {
  modal(
    "把钥匙带回家",
    `<div class="connect-illustration">${icon("home", 46)}</div><p class="modal-intro">用已有的人类住户配对令牌，打开你的真实房子。</p><form id="connect-form"><label>配对令牌<input name="token" type="password" autocomplete="off" required placeholder="粘贴已有的配对令牌"/></label><p class="form-help">钥匙只保留在这个标签页，不放进链接。需要原入口的令牌时，可从房子的配对流程获取。</p><button class="primary full" type="submit">连接房子 ${icon("arrow", 17)}</button></form><button class="text-button full" data-action="demo">继续参观演示小屋</button>${!state.demo ? '<button class="text-button full" data-action="disconnect">断开当前连接</button>' : ""}`,
  );
}
function taskDialog(id) {
  const t = state.tasks.find((t) => t.id === id);
  if (!t) return;
  modal(
    "黑板上的一件事",
    `<span class="status ${esc(t.state)}">${esc(stateNames[t.state])}</span><h3 class="task-detail-title">${esc(t.title)}</h3><p class="modal-intro">交给 ${esc(t.owner)} · ${date(t.created_ts)}</p><div class="detail-section"><small>进展</small><p>${esc(t.notes || "尚未留下进展。")}</p></div>${t.accept ? `<div class="detail-section"><small>完成标准</small><p>${esc(t.accept)}</p></div>` : ""}${t.result ? `<div class="detail-section"><small>结果</small><p>${esc(t.result)}</p></div>` : ""}<form id="task-update" data-id="${esc(id)}"><label>阶段<select name="state">${["open", "doing", "blocked", "done", "dropped"].map((k) => `<option value="${k}" ${t.state === k ? "selected" : ""}>${stateNames[k]}</option>`).join("")}</select></label><label>留下进展<textarea name="notes" maxlength="1000">${esc(t.notes || "")}</textarea></label><label>完成结果<textarea name="result" maxlength="1000">${esc(t.result || "")}</textarea></label><button class="primary full">保存进展</button></form>`,
  );
}
function newTask() {
  modal(
    "轻轻钉上一件事",
    `<form id="new-task"><label>想做什么<input name="title" required maxlength="300" placeholder="给这件事起一个名字"/></label><label>交给谁<select name="owner">${state.members.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("")}</select></label><label>补充说明<textarea name="notes" maxlength="1000" placeholder="背景、约束，或者一句提醒。"></textarea></label><label>怎样才算完成<input name="accept" maxlength="1000" placeholder="写下一个清楚的结果（可选）"/></label><button class="primary full">${icon("plus", 17)} 钉到黑板</button></form>`,
  );
}
function approvalsDialog() {
  modal(
    "等你点头的事",
    `${errorFor("approvals")}${
      state.approvals
        .filter((a) => a.status === "pending")
        .map(
          (a) =>
            `<article class="approval"><span class="eyebrow">${esc(a.resident_name)} 的请求</span><h3>${esc(a.action)}</h3><pre>${esc(JSON.stringify(a.params, null, 2))}</pre><p class="form-help">${a.expires_ts ? "有效期至 " + time(a.expires_ts) : "演示审批，只影响本页"} · 仅本次</p><div class="button-row"><button class="soft-btn" data-decision="deny" data-id="${esc(a.approval_id)}">拒绝</button><button class="primary" data-decision="allow" data-id="${esc(a.approval_id)}">同意这一次</button></div></article>`,
        )
        .join("") ||
      empty("现在没有待确认的事", "需要你做决定时，请求会出现在这里。")
    }`,
  );
}
async function quotaDialog() {
  modal("大家还有多少电量", '<div class="loading">正在查看余量…</div>');
  try {
    if (!state.demo) state.quota = await api("/quota");
    const q = state.quota;
    modal(
      "大家还有多少电量",
      `<p class="modal-intro">数字表示已使用的额度。留一点余量，也留一点从容。</p>${
        (q.providers || [])
          .map(
            (p) =>
              `<article class="quota-card"><h3>${esc(p.label || p.provider)}</h3><p>${esc(p.residents?.join("、") || "")}${p.stale ? " · 缓存数据" : ""}</p><div class="gauge-row">${(
                p.windows || []
              )
                .map((w) => {
                  const n = Number(w.usedPercent);
                  return `<div class="gauge-block"><div class="gauge" style="--value:${Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0}"><strong>${Number.isFinite(n) ? Math.round(n) + "%" : "—"}</strong></div><b>${esc(w.label)}</b><small>${esc(w.resetHint || (w.resetAt ? "重置：" + time(w.resetAt) : "未提供重置时间"))}</small></div>`;
                })
                .join(
                  "",
                )}</div>${p.message ? `<p class="notice">${esc(p.message)}</p>` : ""}<small class="muted">更新于 ${time(p.fetchedAt || q.fetched_at)}</small></article>`,
          )
          .join("") ||
        empty("暂时没有额度信息", "供应商返回数据后会显示在这里。")
      }`,
    );
  } catch (e) {
    modal("大家还有多少电量", empty("暂时没查到", e.message));
  }
}
async function loadDM() {
  const id = state.room,
    gen = state.generation;
  if (!id) return;
  const data = state.demo
    ? state.demoDM?.[id] || [
        {
          id: "demo_dm_" + id,
          from_id: id,
          kind: "dm",
          text: "在的。门给你留着，想聊什么都可以。",
          ts: new Date().toISOString(),
        },
      ]
    : await api("/dm/history?with=" + encodeURIComponent(id) + "&limit=100");
  if (id === state.room && gen === state.generation) {
    state.dm = data;
    const box = $("#messages"),
      pos = box?.scrollTop || 0,
      bottom = box
        ? box.scrollHeight - box.scrollTop - box.clientHeight < 100
        : true;
    const focus = document.activeElement?.id;
    render();
    if ($("#messages"))
      $("#messages").scrollTop = bottom ? $("#messages").scrollHeight : pos;
    if (focus === "compose") $("#compose")?.focus();
  }
}
async function loadMemory() {
  state.memoryResident ||= state.members.find((m) => m.species !== "human")?.id;
  if (!state.memoryResident) return;
  const id = state.memoryResident,
    gen = state.generation;
  try {
    if (!state.demo) {
      const data = await api(
        "/rooms/" + encodeURIComponent(id) + "/memory?limit=100",
      );
      if (gen !== state.generation || id !== state.memoryResident) return;
      state.memory = data;
    }
    delete state.errors.memory;
  } catch (e) {
    state.errors.memory = e.message;
    state.memory = [];
  }
  if (state.page === "memory") render();
}
async function loadWork() {
  state.workResident ||=
    state.runs[0]?.resident_id ||
    state.members.find((m) => m.species !== "human")?.id;
  if (!state.workResident) return;
  const id = state.workResident,
    tab = state.workTab,
    gen = state.generation;
  let w;
  try {
    if (state.demo) {
      w =
        tab === "terminal"
          ? {
              raw: demoTerminal,
              source: "演示终端",
              note: "示例日志，不对应线上命令。",
            }
          : tab === "subruns"
            ? {
                items: [{ id: "demo_subrun", events: demoEvents }],
                note: "子任务交互示例。",
              }
            : {
                events: demoEvents,
                source: "演示事件",
                note: "用于体验界面，非真实执行证据。",
              };
    } else {
      w = await api(
        "/work?resident=" +
          encodeURIComponent(id) +
          "&kind=" +
          (tab === "terminal"
            ? "terminal"
            : tab === "subruns"
              ? "subruns"
              : "session"),
      );
    }
  } catch (e) {
    w = { error: e.message };
  }
  if (
    id !== state.workResident ||
    tab !== state.workTab ||
    gen !== state.generation
  )
    return;
  state.work = w;
  const box = $("#work-content");
  if (box) {
    const scroll = box.scrollTop;
    box.innerHTML = workContent();
    box.scrollTop = scroll;
  }
}
async function refresh() {
  if (state.demo) return;
  const gen = state.generation;
  await Promise.all(
    [
      ["members", "/members"],
      ["messages", "/history?before=9007199254740991&limit=100"],
      ["tasks", "/tasks"],
      ["activity", "/activity?limit=20"],
      ["runs", "/runs?limit=50"],
      ["approvals", "/approval?status=pending"],
    ].map(async ([key, url]) => {
      try {
        const data = await api(url);
        if (gen !== state.generation) return;
        state[key] = data;
        delete state.errors[key];
      } catch (e) {
        if (gen === state.generation) state.errors[key] = e.message;
      }
    }),
  );
  if (gen !== state.generation) return;
  const active = document.activeElement?.id;
  const pos = $("#messages")?.scrollTop;
  const bottom = $("#messages")
    ? $("#messages").scrollHeight -
        $("#messages").scrollTop -
        $("#messages").clientHeight <
      100
    : true;
  render();
  if (active === "compose") $("#compose")?.focus();
  if ($("#messages"))
    $("#messages").scrollTop = bottom ? $("#messages").scrollHeight : pos || 0;
}
async function stream() {
  streamController?.abort();
  if (state.demo) return;
  const controller = new AbortController();
  streamController = controller;
  const gen = state.generation;
  try {
    const r = await fetch(new URL("api/events", location.href.split("#")[0]), {
      headers: { Authorization: "Bearer " + state.token },
      signal: controller.signal,
    });
    if (!r.ok) throw new Error("消息连接中断");
    const reader = r.body.getReader();
    while (!controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          refresh();
          if (state.room) loadDM().catch((e) => toast(e.message));
        }, 600);
      }
    }
  } catch (e) {
    if (!controller.signal.aborted) toast("实时连接暂时断开，正在重连。");
  }
  if (!controller.signal.aborted && gen === state.generation)
    setTimeout(stream, 5000);
}
function navigate(page, room = null) {
  saveDraft();
  if (room !== state.room) state.dm = [];
  state.reply = null;
  state.page = page;
  state.room = room;
  state.query = "";
  if (page === "work") {
    state.workResident ||=
      state.runs[0]?.resident_id ||
      state.members.find((m) => m.species !== "human")?.id;
    state.work = null;
  }
  location.hash = room ? "room/" + encodeURIComponent(room) : page;
  render(false);
  if (room) loadDM().catch((e) => toast(e.message));
  if (page === "work") loadWork();
  if (page === "memory") loadMemory();
}
function enterDemo() {
  streamController?.abort();
  state.generation++;
  state.token = "";
  sessionStorage.removeItem("roof-token");
  Object.assign(state, makeDemo(), {
    demo: true,
    room: null,
    page: "chat",
    work: null,
    workResident: null,
    memoryResident: null,
    errors: {},
    drafts: {},
    dm: [],
    demoDM: {},
    reply: null,
    query: "",
  });
  $("#overlay").innerHTML = "";
  render(false);
}
async function connect(token) {
  const me = await api("/me", {
    headers: { Authorization: "Bearer " + token },
  });
  if (me.species !== "human") throw new Error("请使用人类住户的配对令牌。");
  streamController?.abort();
  state.generation++;
  Object.assign(state, {
    token,
    me,
    demo: false,
    members: [],
    messages: [],
    tasks: [],
    runs: [],
    activity: [],
    approvals: [],
    memory: [],
    work: null,
    room: null,
    page: "chat",
    workResident: null,
    memoryResident: null,
    errors: {},
    drafts: {},
    dm: [],
    reply: null,
    query: "",
  });
  sessionStorage.setItem("roof-token", token);
  $("#overlay").innerHTML = "";
  render(false);
  await refresh();
  stream();
  toast("门开了，欢迎回家。");
}
async function send(form) {
  const input = $("#compose");
  const text = input.value.trim();
  if (!text) return;
  const key = state.room || "public",
    room = state.room;
  const btn = form.querySelector("button");
  btn.disabled = true;
  try {
    let row;
    if (state.demo) {
      row = {
        id: "demo_" + Date.now(),
        from_id: state.me.id,
        kind: room ? "dm" : "say",
        text,
        ts: new Date().toISOString(),
        reply_to: state.reply?.id,
      };
      if (room) {
        state.dm.push(row);
        state.demoDM ||= {};
        state.demoDM[room] = state.dm;
      } else state.messages.push(row);
    } else {
      const payload = room
        ? { to: room, text }
        : { text, ...(state.reply ? { reply_to: state.reply.id } : {}) };
      row = await api(room ? "/dm" : "/say", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (room) state.dm.push(row);
      else state.messages.push(row);
    }
    input.value = "";
    state.drafts[key] = "";
    state.reply = null;
    render();
    $("#messages")?.scrollTo(0, $("#messages").scrollHeight);
    $("#compose")?.focus();
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}
function bind(root = document) {
  root
    .querySelectorAll("[data-page]")
    .forEach((el) => (el.onclick = () => navigate(el.dataset.page)));
  root
    .querySelectorAll("[data-room]")
    .forEach((el) => (el.onclick = () => navigate("chat", el.dataset.room)));
  root.querySelectorAll("[data-reply]").forEach(
    (el) =>
      (el.onclick = () => {
        state.reply = (state.room ? state.dm : state.messages).find(
          (m) => m.id === el.dataset.reply,
        );
        render();
        $("#compose")?.focus();
      }),
  );
  root.querySelectorAll("[data-filter]").forEach(
    (el) =>
      (el.onclick = () => {
        state.filter = el.dataset.filter;
        render();
      }),
  );
  root
    .querySelectorAll("[data-task]")
    .forEach((el) => (el.onclick = () => taskDialog(el.dataset.task)));
  root.querySelectorAll("[data-work]").forEach(
    (el) =>
      (el.onclick = () => {
        state.workResident = el.dataset.work;
        state.work = null;
        render();
        loadWork();
      }),
  );
  root.querySelectorAll("[data-memory]").forEach(
    (el) =>
      (el.onclick = () => {
        state.memoryResident = el.dataset.memory;
        state.memory = state.demo ? makeDemo().memory : [];
        render();
        loadMemory();
      }),
  );
  root.querySelectorAll("[data-tab]").forEach(
    (el) =>
      (el.onclick = () => {
        state.workTab = el.dataset.tab;
        state.work = null;
        render();
        loadWork();
      }),
  );
  root.querySelectorAll("[data-action]").forEach(
    (el) =>
      (el.onclick = async () => {
        const a = el.dataset.action;
        if (a === "connect") connectDialog();
        if (a === "close-modal") $("#overlay").innerHTML = "";
        if (a === "quota") quotaDialog();
        if (a === "new-task") newTask();
        if (a === "approvals") approvalsDialog();
        if (a === "cancel-reply") {
          state.reply = null;
          render();
        }
        if (a === "clear-search") {
          state.query = "";
          render();
        }
        if (a === "demo" || a === "disconnect") enterDemo();
        if (a === "refresh") refresh();
        if (a === "refresh-work") loadWork();
        if (a === "resident-work") {
          state.workResident = el.dataset.id;
          navigate("work");
        }
        if (a === "search")
          modal(
            "在这段对话里找一找",
            '<form id="search-form"><label>关键词<input name="q" placeholder="输入记得的词…" required/></label><button class="primary full">查找</button></form>',
          );
        if (a === "export") {
          if (!state.work) return;
          const raw = state.work.raw || JSON.stringify(state.work, null, 2);
          const url = URL.createObjectURL(
            new Blob([raw], { type: "text/plain;charset=utf-8" }),
          );
          const link = document.createElement("a");
          link.href = url;
          link.download = "same-roof-" + state.workTab + ".txt";
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      }),
  );
  root.querySelectorAll("[data-decision]").forEach(
    (el) =>
      (el.onclick = async () => {
        el.disabled = true;
        try {
          if (state.demo) {
            state.approvals = state.approvals.filter(
              (a) => a.approval_id !== el.dataset.id,
            );
            render();
          } else {
            await api("/approval/" + el.dataset.id, {
              method: "POST",
              body: JSON.stringify({ decision: el.dataset.decision }),
            });
            await refresh();
          }
          approvalsDialog();
          toast(
            el.dataset.decision === "allow"
              ? "这一次，已同意。"
              : "已拒绝这次请求。",
          );
        } catch (e) {
          toast(e.message);
          el.disabled = false;
        }
      }),
  );
  const compose = root.querySelector("#compose-form");
  if (compose) {
    compose.onsubmit = (e) => {
      e.preventDefault();
      send(compose);
    };
    $("#compose").onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        compose.requestSubmit();
      }
    };
  }
  const cf = root.querySelector("#connect-form");
  if (cf)
    cf.onsubmit = async (e) => {
      e.preventDefault();
      const btn = cf.querySelector("button");
      btn.disabled = true;
      try {
        await connect(new FormData(cf).get("token").trim());
      } catch (err) {
        state.token = sessionStorage.getItem("roof-token") || "";
        toast(err.message);
        btn.disabled = false;
      }
    };
  const sf = root.querySelector("#search-form");
  if (sf)
    sf.onsubmit = (e) => {
      e.preventDefault();
      state.query = new FormData(sf).get("q");
      $("#overlay").innerHTML = "";
      render();
    };
  const nf = root.querySelector("#new-task");
  if (nf)
    nf.onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(nf));
      nf.querySelector("button").disabled = true;
      try {
        if (state.demo)
          state.tasks.unshift({
            ...data,
            id: "demo_task_" + Date.now(),
            state: "open",
            owner_id: data.owner,
            owner: member(data.owner).name,
            created_ts: new Date().toISOString(),
          });
        else {
          await api("/tasks", { method: "POST", body: JSON.stringify(data) });
          await refresh();
        }
        $("#overlay").innerHTML = "";
        navigate("tasks");
        toast("已经钉在黑板上了。");
      } catch (err) {
        toast(err.message);
        nf.querySelector("button").disabled = false;
      }
    };
  const tf = root.querySelector("#task-update");
  if (tf)
    tf.onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(tf));
      tf.querySelector("button").disabled = true;
      try {
        if (state.demo)
          Object.assign(
            state.tasks.find((t) => t.id === tf.dataset.id),
            data,
            { updated_ts: new Date().toISOString() },
          );
        else {
          await api("/tasks/" + tf.dataset.id, {
            method: "PATCH",
            body: JSON.stringify(data),
          });
          await refresh();
        }
        $("#overlay").innerHTML = "";
        render();
        toast("进展记下了。");
      } catch (err) {
        toast(err.message);
        tf.querySelector("button").disabled = false;
      }
    };
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("#overlay").innerHTML = "";
  if (e.key === "Tab" && $("#overlay .modal")) {
    const focus = [
      ...$("#overlay .modal").querySelectorAll(
        "button,input,textarea,select,a[href]",
      ),
    ].filter((e) => !e.disabled);
    const first = focus[0],
      last = focus.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }
});
window.addEventListener("hashchange", () => {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash.startsWith("room/")) {
    const id = hash.slice(5);
    if (state.room !== id) navigate("chat", id);
  } else if (labels[hash] && state.page !== hash) navigate(hash);
});
render();
const initialHash = location.hash.slice(1);
if (labels[initialHash]) navigate(initialHash);
if (state.token)
  connect(state.token).catch((e) => {
    enterDemo();
    toast("钥匙暂时不可用：" + e.message);
  });
workPoll = setInterval(() => {
  if (state.page === "work" && !document.hidden) loadWork();
}, 8000);
setInterval(() => {
  if (!state.demo && !document.hidden) refresh();
}, 45000);
