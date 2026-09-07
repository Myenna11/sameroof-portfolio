// 同屋 · 适配器这边的黑板（规划员，W7）：纯函数，不碰盘不碰网。
// 黑板本体在客厅（tasks 表 + /tasks 接口，packages/living-room/blackboard-api.js）；这里只管三件事：
//   1. PIN 指令解析（parsePin）——钉一件 / 改状态，单前缀，靠第二个 token 是不是 task id 区分（规划员 K4 裁定）
//   2. 任务的 due 落成 routine（syncTaskRoutines）——routine 是闹钟，黑板是事
//   3. 醒来时"黑板上我的事"那段怎么渲染（renderTaskLines）
// 顺带把 routine 的时间/校验函数放这儿共用（parseDuration / wallToUtc / parseAt / buildRoutine），room.js 的 mergeRoutines 也用它们。
'use strict';
const cron = require('./cron');

// ---- routine 时间与校验（从 room.js 抽出来共用）----
const DUR_UNIT = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
const DEFAULT_LATE_GRACE = 24 * 3600000;
function parseDuration(v, where) {                                          // '24h' | '90m' | '2d' | 数字按分钟
  if (v == null) return DEFAULT_LATE_GRACE;
  if (typeof v === 'number' && v >= 0) return v * 60000;
  const m = typeof v === 'string' && v.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!m) throw new Error(`${where} late_grace 看不懂「${v}」：写 24h / 90m / 2d，或分钟数`);
  return Number(m[1]) * DUR_UNIT[(m[2] || 'm').toLowerCase()];
}
// 某时区"墙上时间"对应的 UTC 毫秒：用 Intl 反推，不自己算偏移；夏令时边缘再迭代一次
function wallToUtc(y, mo, d, h, mi, sec, tz) {
  const want = Date.UTC(y, mo - 1, d, h, mi, sec); let guess = want;
  for (let i = 0; i < 2; i++) {
    const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(guess))) p[x.type] = x.value;
    guess += want - Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  }
  return guess;
}
// at 字符串 → UTC 毫秒。接受 YYYY-MM-DD[THH:MM[:SS]][Z|±HH:MM]；没写时区按 tz（时间由房子供给）；解析不了抛
function parseAt(v, tz, where) {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${where} at 得是 ISO 8601 字符串，给了 ${JSON.stringify(v)}`);
  const s = v.trim(), m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) throw new Error(`${where} at 看不懂「${s}」：要 ISO 8601，如 2026-09-08T21:00+08:00，或 2026-09-08T21:00（按房子时区 ${tz}）`);
  const [, y, mo, d, h = '00', mi = '00', sec = '00', zone] = m;
  const probe = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec));                 // 25:99、2 月 30 这种 Date.UTC 会悄悄进位，回读一遍对不上就抛
  if (probe.getUTCMonth() !== +mo - 1 || probe.getUTCDate() !== +d || probe.getUTCHours() !== +h || probe.getUTCMinutes() !== +mi || probe.getUTCSeconds() !== +sec) throw new Error(`${where} at 看不懂「${s}」：不是个有效时间`);
  const z = zone && zone.length === 5 ? zone.slice(0, 3) + ':' + zone.slice(3) : zone;
  const ms = zone ? Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${sec}${z.toUpperCase()}`) : wallToUtc(+y, +mo, +d, +h, +mi, +sec, tz);
  if (!Number.isFinite(ms) || new Date(ms).getUTCFullYear() < 1970) throw new Error(`${where} at 看不懂「${s}」：不是个有效时间`);
  return ms;
}
// 一条 routine 原始配置 → 规范形状。缺 id/prompt、cron 与 at 同给或都不给、cron 非法、at 看不懂、cron 型带 late_grace 都抛（配置小，早炸早改）
function buildRoutine(r, where, tz = 'UTC') {
  if (!r || typeof r.id !== 'string' || !r.id) throw new Error(`${where} 缺 id`);
  if (typeof r.prompt !== 'string' || !r.prompt.trim()) throw new Error(`${where} routine ${r.id} 缺 prompt`);
  const hasCron = r.cron != null, hasAt = r.at != null;
  if (hasCron === hasAt) throw new Error(`${where} routine ${r.id} 的 cron 与 at 要二选一（cron=周期，at=一次性），${hasCron ? '两个都给了' : '一个都没给'}`);
  const base = { prompt: r.prompt.trim(), enabled: r.enabled !== false, quiet_hours: r.quiet_hours === 'respect' ? 'respect' : 'ignore' };
  if (hasCron) { if (r.late_grace != null) throw new Error(`${where} routine ${r.id}：late_grace 只对 at 型有意义`); cron.parse(r.cron); return { id: r.id, cron: r.cron, ...base }; }
  const ms = parseAt(r.at, tz, `${where} routine ${r.id}`);
  return { id: r.id, at: new Date(ms).toISOString(), at_ms: ms, late_grace_ms: parseDuration(r.late_grace, `${where} routine ${r.id}`), ...base };
}

// ---- PIN 指令 ----
// 钉：  PIN: <标题> | 验收: <accept> | 给: <owner> | 到期: <ISO 或 五段 cron>     （只有标题必填；| 段可选、顺序无关；给: 缺省 = 自己）
// 改：  PIN <task_id>: doing | done <结果> | blocked <原因> | drop <理由>        （drop → dropped；open 也认，用来拉回来）
// 到期：含空格且五段 → due_cron；否则 → due_at（不带时区按房子 tz，转成带 Z 的 ISO 交给客厅）
// 回 { op:'pin', title, accept?, owner?, due_at?, due_cron? } / { op:'update', id, state, text? } / null（不是 PIN 行，或格式不对、到期看不懂）
const TASK_ID_RE = /^task_[a-z0-9]{6,20}$/i;
const UPDATE_STATES = { doing: 'doing', done: 'done', blocked: 'blocked', drop: 'dropped', dropped: 'dropped', open: 'open' };
const PIN_KEYS = { '验收': 'accept', 'accept': 'accept', '给': 'owner', 'owner': 'owner', 'to': 'owner', '到期': 'due', 'due': 'due', 'at': 'due' };
function parseDue(v, tz) {                                                  // 五段且合法 → cron；否则当 at；都不行回 null
  const s = String(v || '').trim(); if (!s) return null;
  if (s.split(/\s+/).length === 5) { try { cron.parse(s); return { due_cron: s.split(/\s+/).join(' ') }; } catch { return null; } }
  try { return { due_at: new Date(parseAt(s, tz, '黑板')).toISOString() }; } catch { return null; }
}
function parsePin(line, opts = {}) {
  const tz = opts.tz || 'UTC';
  if (typeof line !== 'string') return null;
  const s = line.trim();
  let m = s.match(/^PIN\s+(task_[a-z0-9]+)\s*[:：]\s*(\S+)(?:\s+([\s\S]*))?$/i);
  if (m) {
    if (!TASK_ID_RE.test(m[1])) return null;
    const state = UPDATE_STATES[m[2].toLowerCase()]; if (!state) return null;
    const text = (m[3] || '').trim();
    return { op: 'update', id: m[1], state, ...(text ? { text } : {}) };
  }
  m = s.match(/^PIN\s*[:：]\s*([\s\S]+)$/i); if (!m) return null;
  const segs = m[1].split('|').map(x => x.trim());
  const title = segs.shift(); if (!title) return null;
  const out = { op: 'pin', title };
  for (const seg of segs) {
    if (!seg) continue;
    const kv = seg.match(/^([^:：]+)[:：]\s*([\s\S]*)$/); const key = kv && PIN_KEYS[kv[1].trim().toLowerCase()];
    if (!key) return null;                                                 // 认不得的段：整行不算（别把"| 随手一句"当标题的一部分吞掉）
    const val = kv[2].trim(); if (!val) continue;
    if (key === 'due') { const d = parseDue(val, tz); if (!d) return null; Object.assign(out, d); }
    else out[key] = val;
  }
  return out;
}

// ---- due 落 routine ----
// routines 是 run() 里那个可变数组（tick 每 30 秒遍历它）。对每条有 due_at/due_cron 且 state ∈ open/doing 的任务，
// 确保有一条 id='task:<task.id>' 的 routine；任务没了 / done / dropped / blocked / archived 就把对应 routine 拿掉。
// 回 { added, removed, changed }（changed = 同 id 但 at/cron 变了，room.js 据此清掉 state.routines 里的 done 标记，让改过到期的一次性提醒能再响）
const ROUTINE_PREFIX = 'task:';
const taskRoutine = (task, tz) => {
  const raw = { id: ROUTINE_PREFIX + task.id, prompt: `黑板任务到期：「${task.title}」，看一眼该做什么、说一句。`, enabled: true, quiet_hours: 'ignore' };
  if (task.due_cron) raw.cron = task.due_cron; else { raw.at = task.due_at; raw.late_grace = '24h'; }
  return buildRoutine(raw, '黑板', tz);
};
function syncTaskRoutines(routines, tasks, tz = 'UTC') {
  const want = new Map();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || !t.id || t.archived || !['open', 'doing'].includes(t.state) || !(t.due_at || t.due_cron)) continue;
    try { want.set(ROUTINE_PREFIX + t.id, taskRoutine(t, tz)); } catch { /* 客厅给的 due 不该非法；真非法就当没 due */ }
  }
  const added = [], removed = [], changed = [];
  for (let i = routines.length - 1; i >= 0; i--) {
    const r = routines[i]; if (!String(r.id).startsWith(ROUTINE_PREFIX)) continue;
    const w = want.get(r.id);
    if (!w) { routines.splice(i, 1); removed.push(r.id); continue; }
    if (w.at !== r.at || w.cron !== r.cron || w.prompt !== r.prompt) { routines[i] = w; changed.push(r.id); }
    want.delete(r.id);
  }
  for (const w of want.values()) { routines.push(w); added.push(w.id); }
  return { added, removed, changed };
}

// ---- 醒来时那段 ----
const fmtAt = (ms, tz) => cron.parts(new Date(ms), tz).key.replace('T', ' ') + ' ' + tz;
function renderTaskLines(tasks, tz = 'UTC', limit = 10) {
  const list = (Array.isArray(tasks) ? tasks : []).filter(t => t && t.id).slice(0, limit);   // 客厅已按 due 近的在前、无 due 按创建时间排
  return list.map(t => {
    const extra = [t.accept ? `验收: ${t.accept}` : '', t.due_cron ? `到期: 每 ${t.due_cron}` : t.due_at ? `到期: ${fmtAt(Date.parse(t.due_at), tz)}` : '', t.state === 'blocked' && t.notes ? `卡在: ${t.notes}` : ''].filter(Boolean);
    return `- [${t.state}] ${t.id} ${t.title}${extra.length ? '（' + extra.join('；') + '）' : ''}`;
  });
}
module.exports = { parseDuration, wallToUtc, parseAt, buildRoutine, DEFAULT_LATE_GRACE, parsePin, syncTaskRoutines, renderTaskLines, ROUTINE_PREFIX, TASK_ID_RE };
