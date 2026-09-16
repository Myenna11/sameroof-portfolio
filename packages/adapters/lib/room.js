// 同屋 · 适配器公共件：读房间、连客厅、房子供给时间、醒/睡循环。运行时只需实现 think(system,user,signal)→reply。
// reply 可以是字符串，也可以是 { text, usage }（V2-U）：usage 会记进这次 run，房子不再依赖 R.lastUsage。
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const yaml = require('js-yaml');
const { resolveHouseRoot } = require('@sameroof/house-root');
const { resolveExecutionConfig } = require('@sameroof/schema');
const memoryPlugin = require('@sameroof/plugin-memory');
const cron = require('./cron');
const BB = require('./blackboard');                                       // 黑板：PIN 解析、due 落 routine、渲染；routine 的时间/校验函数也放那儿共用
const C = require('./context');                                          // 上下文拼装的纯函数：打分挑选、摘要帧、工具留壳
const gw = require('./gateway-client');
const { Mailbox } = require('./mailbox');
const { SubrunManager } = require('./subrun-manager');   // subagent V0 (docs/design/subagents.md v5)
const LR = process.env.SAMEROOF_LR || 'http://127.0.0.1:8790';
const RUN = path.join(process.env.HOME || '/root', '.sameroof', 'run');
let houseDir = null;                                                       // 懒解析：真开房间时才找 house.yaml，纯函数测试不碰盘
const houseRoot = () => houseDir || (houseDir = resolveHouseRoot());

function resolveRoomDir(nameOrId) {
  const direct = path.join(houseRoot(), 'rooms', nameOrId);
  if (fs.existsSync(path.join(direct, 'room.yaml'))) return direct;
  for (const d of fs.readdirSync(path.join(houseRoot(), 'rooms'))) {           // 机器用 id，人用名字
    const f = path.join(houseRoot(), 'rooms', d, 'room.yaml'); if (!fs.existsSync(f)) continue;
    const r = yaml.load(fs.readFileSync(f, 'utf8')); if (r && (r.id === nameOrId || r.name === nameOrId)) return path.join(houseRoot(), 'rooms', d);
  }
  throw new Error(`找不到房间：${nameOrId}`);
}
function open(roomName, openOpts = {}) {
  const lrBase = openOpts.lr || LR;                                          // 客厅地址：调用方给的优先（测试起临时客厅），否则 SAMEROOF_LR / 默认
  const roomDir = resolveRoomDir(roomName);
  const room = yaml.load(fs.readFileSync(path.join(roomDir, 'room.yaml'), 'utf8'));
  const house = yaml.load(fs.readFileSync(path.join(houseRoot(), 'house.yaml'), 'utf8'));
  const lrToken = JSON.parse(fs.readFileSync(path.join(RUN, 'living-room-tokens.json'), 'utf8'))[room.id];
  if (!lrToken) throw new Error(`${roomName} 没有客厅 token`);
  const soulPath = path.join(roomDir, 'SOUL.md');
  const soul = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : '';
  const statePath = path.join(houseRoot(), 'state', `adapter-${room.id}.json`);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { last_sleep: null, last_wake: null, wakes_today: 0, day: null };
  const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  const ok2xx = (r, key) => !!(r && typeof r === 'object' && r.$status >= 200 && r.$status < 300 && !r.error && (key ? r[key] : true));   // 只有 2xx 且形状对才算发布成功（审查员 P1-2）
  const api = (method, p, body) => new Promise((resolve, reject) => {
    const u = new URL(p, lrBase);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { authorization: `Bearer ${lrToken}`, 'content-type': 'application/json' } }, res => { let s = ''; res.on('data', c => s += c); res.on('end', () => { let v; try { v = JSON.parse(s); } catch { v = s; } if (v && typeof v === 'object') Object.defineProperty(v, '$status', { value: res.statusCode, enumerable: false }); else v = { $raw: v, $status: res.statusCode }; resolve(v); }); });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
  const tz = (room.schedule && room.schedule.timezone && room.schedule.timezone !== 'inherit') ? room.schedule.timezone : house.timezone;
  const houseTime = () => {
    const now = new Date(); const fmt = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(now);
    const slept = state.last_sleep ? Math.round((now - new Date(state.last_sleep)) / 60000) : null;
    return `【时间】${fmt}（${tz}）。上次活跃：${state.last_sleep || '首次启动'}。本日调用 ${state.wakes_today} 次。`;
  };
  const inQuiet = () => {
    const q = (room.heartbeat && room.heartbeat.quiet_hours) || (room.schedule && room.schedule.quiet_hours) || (house.schedule && house.schedule.quiet_hours); if (!q) return false;
    const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: house.timezone, hour: 'numeric', hour12: false }).format(new Date()));
    const [a, b] = q.split('-').map(s => Number(s.split(':')[0])); return a <= b ? (h >= a && h < b) : (h >= a || h < b);
  };
  const budgetLeft = () => {
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: house.timezone }).format(new Date()); // 按房子的账务时区算"今天"
    if (state.day !== day) { state.day = day; state.wakes_today = 0; save(); }
    const cap = (((room.heartbeat || {}).budget || {}).per_day) || ((((house.defaults || {}).heartbeat || {}).budget || {}).per_day) || {};
    return !cap.requests || state.wakes_today < cap.requests;
  };
  // 住户自己房间的钥匙（软装）：惦记本、给自己的备注
  const concernsPath = path.join(roomDir, 'concerns.md'), notesPath = path.join(roomDir, 'notes.md');
  const readLines = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim()) : [];
  const keys = {
    concerns: () => readLines(concernsPath),
    concern: t => { fs.appendFileSync(concernsPath, `- ${t}\n`); },
    done: t => { const g = s0 => new Set(s0.replace(/^-\s*/, '').split('')); const q = g(t); const lines = readLines(concernsPath); let best = -1, bs = 0; lines.forEach((l, i) => { const w = g(l); let hit = 0; for (const c of q) if (w.has(c)) hit++; const sc = hit / Math.sqrt(w.size + 1); if (sc > bs) { bs = sc; best = i; } }); if (best < 0 || bs < 0.5) return null; const [gone] = lines.splice(best, 1); fs.writeFileSync(concernsPath, lines.map(l => l + '\n').join('')); fs.appendFileSync(path.join(roomDir, 'concerns.done.md'), `- ${new Date().toISOString().slice(0, 10)} ${gone.replace(/^-\s*/, '')}\n`); return gone; },
    note: t => { fs.appendFileSync(notesPath, `- ${new Date().toISOString().slice(0, 10)} ${t}\n`); },
    notes: (n = 8) => readLines(notesPath).slice(-n),
  };
  const runsDir = path.join(houseRoot(), 'state', 'runs'); fs.mkdirSync(runsDir, { recursive: true });
  const recordRun = rec => { try { fs.appendFileSync(path.join(runsDir, `${room.id}.jsonl`), JSON.stringify(rec) + '\n'); } catch {}
    const brief = (rec.lane === 'routine' && { said: '例行的事，responded', silent: 'routine: no action' }[rec.status]) || { said: 'responded', dm: 'sent dm', approval: 'requested approval', approval_invalid: 'invalid approval format', gateway_unavailable: 'gateway unavailable', approval_rejected: 'approval rejected', silent: 'no action', error: 'error', passive_budget: 'budget exhausted', passive_idle: 'idle', nothing: 'no pending', deferred: 'deferred', dry: 'dry-run' }[rec.status] || rec.status;
    const kind = rec.status === 'error' ? 'error' : (rec.model_calls ? 'model_call' : 'wake');
    api('POST', '/activity', { kind, text: `${room.name}：${brief}`, meta: { run_id: rec.id, reason: rec.reason, status: rec.status, ms: rec.ms, usage: rec.usage || null, model_calls: rec.model_calls || 0, error: rec.error || null } }).catch(() => {}); };
  const plugins = room.plugins || (house.defaults || {}).plugins || [];
  const memory = plugins.includes('memory') ? memoryPlugin.open(roomDir) : null;
  return { room, house, roomDir, api, ok2xx, houseTime, inQuiet, budgetLeft, state, save, soul, memory, keys, recordRun, tz, lrBase };
}

const byName = (id, members) => (members.find(m => m.id === id) || {}).name || id;
// 收件箱一行：网关结果（kind=result，只投给申请住户）显示为 [网关结果 <status>] <text>，有下一步建议就附一句
function renderInboxLine(m, selfId) {
  const t = `[${String(m.ts || '').slice(11, 16)}] `;
  if (m.kind === 'result') {
    const meta = m.meta || {}; const next = meta.next || {};
    const hint = next.kind && next.kind !== 'none' ? `（下一步建议：${next.kind}${next.path ? ' ' + next.path : ''}）` : '';
    return `${t}[网关结果 ${meta.status || '?'}] ${m.text}${hint}`;
  }
  return `${t}${m.from}${m.kind === 'dm' ? '(私信给你)' : ''}${m.mentions && m.mentions.includes(selfId) ? '(叫了你)' : ''}：${m.text}`;
}
const DELIVER_MODES = ['interrupt', 'after_turn', 'inject'];
const LANE = { human: 4, routine: 3, agent: 2, heartbeat: 1 };   // 车道优先级：人 > 例行 > agent > 心跳（例行是明写下的 standing order，压过 agent 闲聊；agent 的 pending 不丢，只是等一轮）
const LANES = ['human', 'routine', 'agent', 'heartbeat'];
// ---- 例行（routines）：house/room 的 extensions["dev.sameroof.routines"]，每条 { id, cron | at, prompt, enabled?, quiet_hours?, late_grace? } ----
// 房间的追加在房子之后，同 id 房间覆盖房子。字段缺、cron/at 非法、cron 与 at 同给或都不给、同一处 id 重复都直接抛（配置小，早炸早改）。
// cron 型周期触发；at 型一次性（ISO 8601，带 Z 或 ±HH:MM；不带时区按房子 tz 解释），响过一次 state 记 done，之后不再响（配置里的 enabled 是人写的，不动）。
const { buildRoutine, DEFAULT_LATE_GRACE } = BB;                        // parseDuration / wallToUtc / parseAt 也在那儿   // 抽到 lib/blackboard.js 共用（黑板任务落 routine 也走 buildRoutine）
const atMs = r => (r.at_ms != null ? r.at_ms : Date.parse(r.at));
const graceMs = r => (r.late_grace_ms != null ? r.late_grace_ms : DEFAULT_LATE_GRACE);
const fmtAt = (ms, tz) => cron.parts(new Date(ms), tz).key.replace('T', ' ') + ' ' + tz;   // 给人看的：房子时区的 'YYYY-MM-DD HH:MM tz'
function mergeRoutines(house, room, tz = 'UTC') {
  const list = (o, where) => { const raw = Object.hasOwn(o || {}, 'routines') ? (o.routines || []) : (((o || {}).extensions || {})['dev.sameroof.routines'] || []); if (!Array.isArray(raw)) throw new Error(`${where} 的 routines 得是数组`);   // 核心字段 routines 优先，旧 extension 回退
    const seen = new Set(); return raw.map((r, i) => {
      if (!r || typeof r.id !== 'string' || !r.id) throw new Error(`${where} routines[${i}] 缺 id`);
      if (seen.has(r.id)) throw new Error(`${where} routines 里 id 重复：${r.id}`); seen.add(r.id);
      return buildRoutine(r, where, tz); }); };
  const out = new Map(); for (const r of [...list(house, 'house.yaml'), ...list(room, 'room.yaml')]) out.set(r.id, r);
  return [...out.values()];
}
// 该不该触发。cron 型：匹配 cron 且这一分钟（按 tz 的 'YYYY-MM-DDTHH:MM' 键）没触发过。at 型：now ≥ at、state 里没 done、且没晚过 late_grace（错过太久就不响了）。
// 返回键（cron 型是分钟键，at 型是 at 的 ISO）或 null，不改 state。
function dueNow(routine, state, now = new Date(), tz = 'UTC') {
  if (!routine.enabled) return null;
  const st = ((state || {}).routines || {})[routine.id] || {};
  if (routine.at != null) { if (st.done) return null; const late = now.getTime() - atMs(routine); return (late < 0 || late > graceMs(routine)) ? null : routine.at; }
  const t = cron.parts(now, tz); if (!cron.matches(routine.cron, now, tz)) return null;
  return st.last_fired === t.key ? null : t.key;
}
// 上次触发到现在之间错过了几次（进程没跑时的），只用来在启动时记一行；最多往回数 cap 分钟。at 型：没响过且晚过 late_grace 记 1，否则 0（grace 内的由 tick 补跑）
function countMissed(routine, state, now = new Date(), tz = 'UTC', cap = 7 * 24 * 60) {
  const st = ((state || {}).routines || {})[routine.id] || {};
  if (routine.at != null) return (routine.enabled && !st.done && now.getTime() - atMs(routine) > graceMs(routine)) ? 1 : 0;
  if (!st.last_fired) return 0;
  const nowKey = cron.parts(now, tz).key; let n = 0;
  for (let k = 1; k <= cap; k++) { const d = new Date(now.getTime() - k * 60000); const key = cron.parts(d, tz).key; if (key <= st.last_fired) break; if (key !== nowKey && cron.matches(routine.cron, d, tz)) n++; }
  return n;
}
const abortable = (promise, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const onAbort = () => reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  promise.then(v => { signal.removeEventListener('abort', onAbort); resolve(v); }, e => { signal.removeEventListener('abort', onAbort); reject(e); });
});

// think 的返回值：字符串照旧；{ text, usage } 就拆开（V2-U）
const unpackReply = r => (r && typeof r === 'object' && !Array.isArray(r)) ? { text: r.text == null ? '' : String(r.text), usage: (r.usage && typeof r.usage === 'object') ? r.usage : null } : { text: r == null ? '' : String(r), usage: null };
const addUsage = (run, usage) => { if (!usage) return; if (!run.usage) { run.usage = { ...usage }; return; } for (const [k, v] of Object.entries(usage)) if (typeof v === 'number' && typeof run.usage[k] === 'number') run.usage[k] += v; else if (run.usage[k] === undefined) run.usage[k] = v; };   // 同一次 run 调了两回模型：数字相加
// subagent config: room.enabled ?? house.enabled ?? false (room can tighten); budget merged per field; every cap must be a finite positive integer.
// A partial room budget must NOT wipe the house's other caps (that produced NaN → unlimited before).
function mergeSubagentConfig(houseSub, roomSub) {
  const h = houseSub && typeof houseSub === 'object' ? houseSub : {}; const r = roomSub && typeof roomSub === 'object' ? roomSub : {};
  const pickInt = (v, d, lo, hi) => { const n = Number.isInteger(v) ? v : d; return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
  const hb = h.budget || {}, rb = r.budget || {};
  const houseTools = Array.isArray(h.tools) ? h.tools : ['core.fs.read'];
  const roomTools = Array.isArray(r.tools) ? r.tools.filter(t => houseTools.includes(t)) : houseTools;   // room narrows within house
  return {
    enabled: r.enabled !== undefined ? !!r.enabled : h.enabled !== undefined ? !!h.enabled : false,
    max_parallel: Math.min(pickInt(r.max_parallel, pickInt(h.max_parallel, 2, 1, 8), 1, 8), pickInt(h.max_parallel, 2, 1, 8)),
    budget: {
      model_calls: Math.min(pickInt(rb.model_calls, pickInt(hb.model_calls, 15, 1, 200), 1, 200), pickInt(hb.model_calls, 15, 1, 200)),
      tool_calls: Math.min(pickInt(rb.tool_calls, pickInt(hb.tool_calls, 20, 0, 500), 0, 500), pickInt(hb.tool_calls, 20, 0, 500)),
      minutes: Math.min(pickInt(rb.minutes, pickInt(hb.minutes, 10, 1, 240), 1, 240), pickInt(hb.minutes, 10, 1, 240)),
    },
    tools: roomTools,
    inherit_max_chars: Math.min(pickInt(r.inherit_max_chars, pickInt(h.inherit_max_chars, 12000, 0, 200000), 0, 200000), pickInt(h.inherit_max_chars, 12000, 0, 200000)),
    summary_max_words: pickInt(r.summary_max_words, pickInt(h.summary_max_words, 300, 20, 5000), 20, 5000),
  };
}
// SUB: <task> | 带上: <brief> | 引用: msg_id,path | 工具: a,b | 预算: m/t/min | 继承: N   —— 带上: 必填除非 继承:>0（零上下文默认）
function parseSubLine(line, { inbox = [], recentCtx = '', inheritMax = 12000 } = {}) {
  const body = line.replace(/^\s*SUB[:：]\s*/i, '');
  const segs = body.split('|').map(s => s.trim()).filter(Boolean); if (!segs.length) return null;
  const spec = { task: segs[0], brief: '', refs: [], tools: undefined, budget: undefined, inherit: [] };
  for (const s of segs.slice(1)) {
    const m = /^(带上|引用|工具|预算|继承)[:：]\s*(.*)$/.exec(s); if (!m) continue;
    const v = m[2].trim();
    if (m[1] === '带上') spec.brief = v;
    else if (m[1] === '引用') for (const r of v.split(/[,，]/).map(x => x.trim()).filter(Boolean)) { const msg = inbox.find(x => x.id === r); spec.refs.push(msg ? { kind: 'message', ref: r, text: msg.text } : { kind: 'path', ref: r }); }
    else if (m[1] === '工具') spec.tools = v.split(/[,，]/).map(x => x.trim()).filter(Boolean);
    else if (m[1] === '预算') { const [mc, tc, mi] = v.split('/').map(x => parseInt(x, 10)); spec.budget = { ...(mc ? { model_calls: mc } : {}), ...(tc ? { tool_calls: tc } : {}), ...(mi ? { minutes: mi } : {}) }; }
    else if (m[1] === '继承') { const n = parseInt(v, 10); if (n > 0 && recentCtx) { const lines = recentCtx.split('\n').slice(-n).join('\n'); spec.inherit = [{ role: 'user', content: '【父任务最近上下文，共 ' + n + ' 行】\n' + lines.slice(-inheritMax) }]; } }
  }
  if (!spec.task) return null;
  if (!spec.brief && !spec.inherit.length) return null;   // zero-context default: the parent must brief
  return spec;
}
async function run(roomName, runtimeName, think, opts = {}) {
  const R = open(roomName, { lr: opts.lr }); const { room, api, ok2xx, state, save, soul } = R; const lrBase = R.lrBase;
  const stop = opts.signal || null; let stopped = false;                       // opts.signal：abort 后关 SSE、清 timer、不再 pump，睡下，run() resolve（没给就照旧）
  // ---- 地基配置（先放 extensions.dev.sameroof.*，等审查员升核心字段）----
  // deliver / limits 用审查员 Y2 的共同解析口（核心字段优先，旧 extensions.dev.sameroof.* 只作迁移回退）；routines 原始列表也核心优先，但仍过我们自己的 mergeRoutines（支持 W1.1 的 at，等 schema 对齐后再切到 resolveExecutionConfig）
  const exec = resolveExecutionConfig(R.house, room);
  const limits = exec.limits;
  const deliverCfg = exec.deliver;
  const routines = mergeRoutines(R.house, room, R.tz); state.routines = state.routines || {};   // 可变数组：黑板任务的 due 会往里 push / splice（syncTaskRoutines），tick 遍历的就是它
  const routineById = id => routines.find(r => r.id === id);
  // ---- subagent V0：manager 在 wake() 之外，不占 active、不受 watchdog；结果走本地 mailbox；只有 broker-direct 传 callOnce ----
  const subCfg = mergeSubagentConfig((R.house.defaults || {}).subagent, room.subagent);   // room 可收紧、字段级合并、预算校验（审查员 P1-3）
  const mailbox = subCfg.enabled ? new Mailbox(path.join(R.roomDir, 'state', 'mailbox.jsonl')) : null;
  let subruns = null;
  if (subCfg.enabled && typeof opts.callOnce === 'function') {
    subruns = new SubrunManager({ dir: path.join(R.roomDir, 'state'), mailbox, requestWake: (lane, why) => requestWake(lane, why), model: opts.callOnce, gateway: gw, residentId: room.id, residentName: room.name, config: subCfg, log: (...a) => fs.writeSync(2, `[${room.name} subrun] ${a.join(' ')}\n`) });
  } else if (subCfg.enabled) fs.writeSync(2, `[${room.name}] subagent.enabled 但 runtime ${runtimeName} 未提供 callOnce：SUB: 行会被丢弃并留注。\n`);
  const subOwns = m => !!(subruns && m && m.kind === 'result' && m.meta && m.meta.request_id && subruns.ownsRequest(m.meta.request_id));   // 合同 B：按 gateway 背书的 request_id 认，不看前缀
  // ---- 黑板（W7）：每次醒来拉一次"我的事"（open/doing/blocked），拉不到就静默（stderr 一行），不影响醒来；拉到就把 due 同步进 routines
  const fetchTasks = async () => { try { const t = await api('GET', '/tasks?owner=me&state=open,doing,blocked'); if (Array.isArray(t)) return t; fs.writeSync(2, `[${room.name}] 黑板拉不到（${JSON.stringify(t).slice(0, 120)}），这轮当没有\n`); } catch (e) { fs.writeSync(2, `[${room.name}] 黑板拉不到（${e.message}），这轮当没有\n`); } return []; };
  const syncTasks = tasks => { const d = BB.syncTaskRoutines(routines, tasks, R.tz);
    for (const id of d.changed) delete state.routines[id];                 // 到期改了：一次性的 done 标记清掉，让它能再响
    for (const id of d.removed) delete state.routines[id];
    if (d.added.length || d.removed.length || d.changed.length) { save(); fs.writeSync(2, `[${room.name}] 黑板 routine 同步：+${d.added.length} -${d.removed.length} ~${d.changed.length}（现 ${routines.length} 条）\n`); }
    return d; };
  let members = [];
  const refreshMembers = async () => { try { const m = await api('GET', '/members'); if (Array.isArray(m)) members = m; } catch {} return members; };
  const memberById = id => members.find(m => m.id === id);
  const isHuman = id => (memberById(id) || {}).species === 'human';
  // 投递模式解析：消息自带 > 房间对这个人的设定 > 房间按人/agent 的默认 > 房子默认 > after_turn
  const resolveDeliver = m => {
    const explicit = m.meta && m.meta.deliver; if (DELIVER_MODES.includes(explicit)) return explicit;
    const s = memberById(m.from_id) || {};
    const per = deliverCfg.from[s.name] || deliverCfg.from[s.id]; if (DELIVER_MODES.includes(per)) return per;
    const byKind = deliverCfg[s.species === 'human' ? 'human' : 'agent']; return DELIVER_MODES.includes(byKind) ? byKind : 'after_turn';
  };
  // ---- 运行队列：每住户一条，四车道（human > routine > agent > heartbeat），同时只跑一个 run ----
  const pending = { human: null, routine: [], agent: null, heartbeat: null };   // 每车道最多记一个待醒原因（一次醒来读全部未读，合并即可）；例行各带各的提示词，排队不合并
  let active = null;                                                // { lane, reason, ctrl, startedAt }
  let hb = null;                                                    // 心跳调度句柄
  const shift = [];                                                 // 这一班发生的事，睡前写进交接信
  // V2-W8d 增量上下文：本班第 2 轮起 user 只发新增。inc 记住这一班已发过的记忆 id、黑板快照、家里的人一行、私信伙伴；
  // think.shift.turns()==0（新班 / 归档后）就重置回"全发"。持久化 shift 重启后 turns>0 但 inc 为空 → 记忆/黑板会多发一次，无害。
  let inc = null;
  const shiftTurns = () => (think.shift && typeof think.shift.turns === 'function') ? think.shift.turns() : 0;
  function requestWake(lane, reason, deliver = 'after_turn') {
    if (stopped) return Promise.resolve();
    if (active) {
      if (lane === 'routine') { if (!pending.routine.includes(reason)) pending.routine.push(reason); } else pending[lane] = pending[lane] || reason;
      if (deliver === 'interrupt' && LANE[lane] >= LANE[active.lane]) {
        fs.writeSync(2, `[${room.name}] 打断当前一轮（${active.reason}）：${reason}\n`);
        active.ctrl.abort(new Error(`被打断：${reason}`));
      } else fs.writeSync(2, `[${room.name}] 正忙（${active.reason}），${reason} 排在 ${lane} 车道等这轮结束\n`);
      return Promise.resolve();
    }
    return runOnce(lane, reason);
  }
  function pump() { if (stopped) return; for (const lane of LANES) { const r = lane === 'routine' ? pending.routine.shift() : pending[lane]; if (!r) continue; if (lane !== 'routine') pending[lane] = null; runOnce(lane, r); return; } }
  async function runOnce(lane, reason) {
    const ctrl = new AbortController();
    active = { lane, reason, ctrl, startedAt: Date.now() };
    state.last_run_at = new Date().toISOString(); save();
    const wd = setTimeout(() => ctrl.abort(new Error(`看门狗：一轮超过 ${limits.run_timeout_ms}ms`)), limits.run_timeout_ms);
    try { await wake(reason, lane, ctrl.signal); }
    finally { clearTimeout(wd); active = null; if (hb) hb.reschedule(); pump(); }
  }

  async function wake(reason, lane, signal) {
    const run = { id: 'run_' + Date.now().toString(36), resident_id: room.id, ts: new Date().toISOString(), reason, lane, status: 'started' };
    let mailItems = [], mailMarked = true;   // mailMarked=true until the wake actually read the mailbox; then every exit must mark (finally 兜底)
    const routine = lane === 'routine' ? routineById(reason.replace(/^routine:/, '')) : null; if (routine) run.routine_id = routine.id;
    const t0 = Date.now();
    try {
      if (!R.budgetLeft()) { console.log('[预算] daily request budget exhausted, passive mode'); run.status = 'passive_budget'; return; }
      const inboxAll = await api('GET', '/inbox'); if (!Array.isArray(inboxAll)) throw new Error('客厅没开门: ' + JSON.stringify(inboxAll));
      const subResults = inboxAll.filter(subOwns);                          // 合同 B（第二处）：子任务的网关结果不进 prompt、不算唤醒理由，静默 ack
      if (subResults.length) { for (const m of subResults) subruns.noteDelivered(m.meta.request_id); await api('POST', '/inbox/ack', { ids: subResults.map(m => m.id) }).catch(() => {}); }
      const inbox = inboxAll.filter(m => !subOwns(m));
      mailItems = mailbox ? mailbox.pending() : [];                   // 本地 mailbox：子任务结果，和客厅消息分开渲染
      run.mail_items = mailItems.length; mailMarked = false;
      const myTasks = await fetchTasks(); syncTasks(myTasks);              // 黑板上我的事（每次醒来都看一眼，顺手把 due 落成 routine；没叫我也同步）
      // 例行醒来：inbox 空也不算 nothing，没 @ 我也不 deferred——例行本来就不是因为有人叫
      if (!routine && inbox.length === 0 && mailItems.length === 0 && reason !== 'heartbeat') { run.status = 'nothing'; return; }   // 有子任务结果也算有事
      if (!routine && reason !== 'heartbeat' && mailItems.length === 0 && !inbox.some(m => m.kind === 'dm' || (m.mentions && m.mentions.includes(room.id)))) { console.log('[醒] 有新话但没叫我，留到心跳再看'); run.status = 'deferred'; return; }   // 子任务结果算叫了我（设计 §4.1）
      if (inbox.length === 0 && reason === 'heartbeat') {
        if (!R.keys.concerns().length && !myTasks.length) { console.log('[心跳] idle: no pending tasks or messages, skipping model call'); run.status = 'passive_idle'; return; }
      }
      run.tasks = myTasks.map(t => ({ id: t.id, state: t.state, title: String(t.title).slice(0, 80) }));
      await refreshMembers();
      const hoPath = path.join(R.roomDir, 'handover', 'latest.md'); const handover = fs.existsSync(hoPath) ? fs.readFileSync(hoPath, 'utf8') : '（没有交接信）';
      state.wakes_today++; state.last_wake = new Date().toISOString(); save();
      // ---- 上下文预算（房间可配，缺省来自 house.yaml defaults.context）----
      const ctx = Object.assign({ recent_messages: 20, recent_max_chars: 4000, memory_hits: 4, memory_recent: 3, frame_max_chars: 400 },
        ((R.house.defaults || {}).context) || ((R.house.extensions || {})['dev.sameroof.context']) || {},
        room.context || ((room.extensions || {})['dev.sameroof.context']) || {});
      const turn = shiftTurns();
      if (turn === 0 || !inc) {
        inc = { memoryIds: new Set(), taskSnap: null, membersLine: '', dmPartners: new Set(), stableMem: '' };
        // V2-W8e 撑前缀：一班内不变的记忆进 system。稳定 = 人审过的（approved）或被召回过 ≥2 次的；按 approved 优先、hits 降序、新的优先，
        // 塞到 ctx.system_memory_max_chars（缺省 6000）为止。这些 id 视为"本班已发"，user 侧召回只发剩下的（pending/新增）。
        if (R.memory) {
          const all = R.memory.recent(500);
          const stable = all.filter(m => m && m.id && ((m.review || (m.reviewed ? 'approved' : 'pending')) === 'approved' || (m.hits || 0) >= (ctx.system_memory_min_hits ?? 2)))
            .sort((x, y) => (((y.review === 'approved') - (x.review === 'approved')) || ((y.hits || 0) - (x.hits || 0)) || String(y.ts || '').localeCompare(String(x.ts || ''))));
          const budget = ctx.system_memory_max_chars ?? 6000; const picked = []; let used = 0;
          for (const m of stable) { const len = String(m.content || '').length + 24; if (used + len > budget) break; picked.push(m); used += len; }
          picked.sort((x, y) => String(x.ts || '').localeCompare(String(y.ts || '')));            // 进 system 按时间正序，读起来像一本子
          if (picked.length) { inc.stableMem = '【我的长期记忆（这一班不变）】\n' + R.memory.render(picked); for (const m of picked) inc.memoryIds.add(m.id); }
          run.system_memories = picked.length;
        }
      }
      const incremental = turn > 0;                                       // 本班第 2 轮起：只发新增（首轮全发，住户要靠它建立认知）
      run.turn = turn; run.incremental = incremental;
      let remembered = '';
      if (R.memory) {
        const q = inbox.map(m => m.text).join(' ') || handover;
        const hits = await R.memory.recall(q, ctx.memory_hits); const recent = R.memory.recent(ctx.memory_recent).filter(m => !hits.find(h => h.id === m.id));
        let list = [...hits, ...recent];
        { const f = C.freshMemories(list, inc.memoryIds); list = f.fresh; for (const id of f.ids) inc.memoryIds.add(id); }   // 首轮：去掉已进 system 的；增量轮：去掉本班发过的
        if (list.length) remembered = (incremental ? '【新想起来的事】\n' : '【我记得的事】\n') + R.memory.render(list);
      }
      // ---- 上下文三条规则（细节与打分表见 lib/context.js 与 README"上下文怎么拼"）----
      // 1. remembered 不进 system，放 user 开头（system 只放一班内稳定的：人设、规矩、交接信、惦记本、小本）
      // 2. 刚才的话 / 私信往来：候选 = 最近 recent_messages*2 条（上限 60）里未读之外的，打分取最高 recent_messages 条、按时间重排；超 recent_max_chars 从分低的丢
      // 3. 工具留壳：meta.kind==='tool' 的消息（住户有手之后客厅里会出现）在刚才的话 / 私信 / 收件箱里都只显示 [工具调用: X]，结果不展开——等网关投回收件箱的正文消息
      let recentCtx = ''; let recentScored = [];
      const unreadIds = new Set(inbox.map(m => m.id));
      const scoreOpts = { roomId: room.id, inbox, members, now: Date.now() };
      const frame = (m, ts, tag, maxChars = ctx.frame_max_chars) => C.renderFrame(m, { roomId: room.id, members, ts, tag, maxChars });
      const pick = (rows, limit, maxChars, ts) => C.pickRecent(rows, { limit, maxChars, score: m => C.scoreRecent(m, scoreOpts), render: m => frame(m, ts) });
      if (ctx.recent_messages > 0 && !incremental) {                  // 增量轮不灌"刚才的话"：他自己就在这段对话里，客厅里别人的新话走未读
        const pool = Math.min(60, ctx.recent_messages * 2);
        const hist = await api('GET', `/history?before=${Number.MAX_SAFE_INTEGER}&limit=${Math.min(200, pool + inbox.length)}`).catch(() => []);  // 最近的（不是最早的）；多拿 inbox.length 条免得未读吃掉候选池
        const older = (Array.isArray(hist) ? hist : []).filter(m => !unreadIds.has(m.id)).slice(-pool);
        const r = pick(older, ctx.recent_messages, ctx.recent_max_chars, 'short');
        recentScored = r.scored.slice(0, 20);
        if (r.lines.length) recentCtx = '【客厅里刚才的话（你已经看过、也可能已经回过——别再回一遍）】\n' + r.lines.join('\n');
      }
      // 私信往来：谁私信了我，就把和他最近的来回带上（含我自己回过的），免得每次都从头答一遍。同样打分挑选，只在该 partner 的 dm 历史内
      let dmCtx = '';
      {
        const partners = [...new Set(inbox.filter(m => m.kind === 'dm').map(m => m.from_id))].filter(Boolean);
        const blocks = []; const n = ctx.dm_recent || 10; const pool = Math.min(60, n * 2);
        for (const pid of partners.slice(0, 3)) {
          if (incremental && inc.dmPartners.has(pid)) continue;           // 这一班已经带过他的往来，后面的都在对话里
          inc.dmPartners.add(pid);
          const h = await api('GET', `/dm/history?with=${encodeURIComponent(pid)}&limit=${Math.min(200, pool + inbox.length)}`).catch(() => []);
          const rows = (Array.isArray(h) ? h : []).filter(m => !unreadIds.has(m.id)).slice(-pool);
          if (!rows.length) continue;
          const r = pick(rows, n, ctx.dm_max_chars || 3000, 'long');
          if (r.lines.length) blocks.push(`【和 ${byName(pid, members)} 的私信往来（你已经回过的，别再回一遍）】\n` + r.lines.join('\n'));
        }
        dmCtx = blocks.join('\n');
      }
      // ---- 提示按"变化频率"排：system 只放一班内稳定的（人设、规矩、交接信、惦记本、小本）----
      // 网关动作列表从 house/room permissions 算（GATEWAY.md §6：ceiling 缺或 deny 即拒；房间没写继承 house）——提示和策略对得上，不写死
      const gwActions = ['core.fs.read', 'core.fs.write', 'core.exec'].filter(a => { const c = ((R.house.defaults || {}).permissions || {})[a]; const rv = (room.permissions || {})[a]; const eff = rv === undefined ? c : rv; return c && c !== 'deny' && eff && eff !== 'deny'; });
      const system = [
        soul || `你是${room.name}。`,
        '',
        '【这是客厅，不是对话框】你是这个家里的一个人，不是谁的助手。屋里的人（人和 agent）都在，你听到的话不一定是对你说的。',
        '- 想叫谁就在话里写 @名字（可以叫其他 agent，他们会醒来看）。没被叫的话你可以接，也可以不接。',
        '- 一次可以只回一个人；几个人说了话，回的时候说清楚回的是谁。',
        '- 家里的人（human）直接 @ 了你，至少应一声，哪怕就一句。(静默) 是给没被叫的时候用的。',
        '- 不想让全家看见就私信：整条回复以 DM: 收件人 开头。',
        gw.available(room.id) && gwActions.length
          ? `- 你只搬字，不能执行命令。要做高危动作（读写文件、跑命令），整条回复只写一行：APPROVAL: <action> <JSON 参数>，房子会登记到网关等人审批，结果以"网关结果"投回你的收件箱。例：APPROVAL: core.fs.write {"root_id":"own-room","path":"notes/today.md","content":"今天的记录…","encoding":"utf8","mode":"replace"}（你现在被开放的动作：${gwActions.join(' / ')}；别的动作网关会拒；参数必须是严格 JSON 对象，键不重复，别夹别的字）。`
          : '- 你只搬字，不能执行命令。能力网关还没上线，现在也没法申请动手（别写 APPROVAL，写了也登记不上）；想看什么文件、想改什么，直接在客厅说，让人帮你。',
        R.memory ? '- 值得以后还记得的事，在回复末尾另起一行写 REMEMBER: 一句话（可多行）。房子会存下来，标记为你自己写的、未审。' : '',
        '- 你自己房间的钥匙（同样另起一行）：CONCERN: 一句话 记进惦记本；DONE: 一句话 划掉做完的；NOTE: 一句话 记在自己的小本上；' + (R.memory ? 'FORGET: 一句话 把记忆里对上的那条冷藏（不删）。' : ''),
        '- 黑板：家里共享的事。钉一件：PIN: 标题 | 验收: … | 给: 名字 | 到期: 时间；改状态：PIN <task_id>: doing / done 结果 / blocked 原因 / drop 理由。没进展不更新。',
        ...(subruns ? ['- 子任务：需要去查、去搜、去读一堆文件时，别自己灌进上下文，派一个子任务：另起一行 SUB: 任务一句话 | 带上: 它需要知道的全部背景（它没有你的记忆和这段对话）| 工具: core.exec.ro,core.fs.read。它在只读沙箱里干活，做完把结论放进【子任务结果】叫醒你。先正常回复人（比如"我去查"），SUB: 行会被剥掉不公开。不能写文件、不能等审批；那些你自己用 APPROVAL: 申请。'] : []),
        '',
        '【上次交接信】', handover,
        R.keys.concerns().length ? '【我惦记的事】\n' + R.keys.concerns().join('\n') : '',
        R.keys.notes().length ? '【我自己的小本】\n' + R.keys.notes().join('\n') : '',
        inc.stableMem,                                                                               // V2-W8e：稳定记忆撑前缀（本班不变，吃缓存）
      ].filter(x => x !== '').join('\n');
      // 每次醒都变的一律放 user：时间、在场的人、为什么醒、召回、刚才的话、私信往来、未读。system 一班内基本不动，prompt cache 才吃得到。
      const mLine = C.membersLine(members);
      const td = C.diffTasks(inc.taskSnap, myTasks); inc.taskSnap = td.snapshot;
      let wakeHead;
      if (!incremental) {
        wakeHead = [
          R.houseTime(), mLine, `【为什么醒】${reason}`,
          myTasks.length ? '【黑板上我的事】\n' + BB.renderTaskLines(myTasks, R.tz).join('\n') : '',
          remembered, recentCtx, dmCtx,
        ].filter(x => x !== '').join('\n');
      } else {
        const tz = R.tz; const nowLine = `【现在】${new Intl.DateTimeFormat('zh-CN', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date())}（本班第 ${turn + 1} 轮）`;
        const bb = [];
        if (td.added.length) bb.push('新钉的：\n' + BB.renderTaskLines(td.added, tz).join('\n'));
        if (td.changed.length) bb.push('变了的：\n' + BB.renderTaskLines(td.changed, tz).join('\n'));
        if (td.removed.length) bb.push('不在黑板上了：' + td.removed.map(t => `${t.id}「${t.title}」`).join('、'));
        wakeHead = [
          nowLine,
          mLine !== inc.membersLine ? mLine : '',
          `【为什么醒】${reason}`,
          bb.length ? '【黑板变化】\n' + bb.join('\n') : '',
          remembered, dmCtx,
        ].filter(x => x !== '').join('\n');
      }
      inc.membersLine = mLine;
      const mailText = mailItems.length ? Mailbox.render(mailItems) : '';
      const inboxText = (mailText ? mailText + '\n\n' : '') + '【你没读的客厅记录（按时间）】\n' + inbox.map(m => m.kind === 'result' ? renderInboxLine(m, room.id) : frame(m, 'short', `${m.kind === 'dm' ? '(私信给你)' : ''}${m.mentions && m.mentions.includes(room.id) ? '(叫了你)' : ''}`, 0)).join('\n');   // 未读不截断，只做工具留壳；网关结果单独渲染
      const user = wakeHead + '\n\n' + (routine ? `【例行】${routine.prompt}` + (routine.at ? `（这是一次性提醒，原定 ${fmtAt(atMs(routine), R.tz)}）` : '') + ((inbox.length || mailItems.length) ? '\n\n' + inboxText : '') + '\n\n例行的事做完就说一句，没什么要说就回 (静默)。'
        : (inbox.length || mailItems.length) ? inboxText + (incremental ? '\n\n看完决定：要不要说、对谁说。只回新的；这一班里你已经说过的不要再说一遍。像家里人说话，不要列清单；没什么要说就回 (静默)。' : '\n\n看完决定：要不要说、对谁说。只回新的；上面"刚才的话"里已经有人回过的、你自己说过的，不要再回一遍。像家里人说话，不要列清单；没什么要说就回 (静默)。')
        : '心跳醒来。客厅没人叫你，但惦记本或黑板上有你的事。要是确实该对家里人说一句就说，没有就回 (静默)。');
      const frozenSystem = (incremental && think.shift && Array.isArray(think.shift.messages) && think.shift.messages.length && think.shift.messages[0].role === 'system') ? think.shift.messages[0].content : system;   // 本班 system 冻结：惦记本/小本改了也不打断累积（他自己写的他知道；下一班再进 system）
      run.system_frozen = frozenSystem !== system;
      run.heard = inbox.map(m => ({ id: m.id, from: m.from, kind: m.kind, text: m.text.slice(0, 300), mentioned: !!(m.mentions && m.mentions.includes(room.id)) }));
      run.context = { system_chars: system.length, user_chars: user.length, memories_recalled: remembered ? remembered.split('\n').length - 1 : 0, recent_lines: recentCtx ? recentCtx.split('\n').length - 1 : 0, dm_lines: dmCtx ? dmCtx.split('\n').length : 0, recent_scored: recentScored, system_preview: system.slice(0, 1200), user_preview: user.slice(0, 1200) };
      // 跳数：人说的话 hop=0；agent 回话 = 听到的 agent 消息里最大 hop + 1。超过上限的链只写不叫醒（防两个 agent 无限对聊）
      const hopIn = inbox.filter(m => !isHuman(m.from_id)).reduce((a, m) => Math.max(a, Number((m.meta || {}).hop) || 0), 0);
      const hopOut = (room.species === 'human' || routine) ? 0 : hopIn + 1;   // 例行醒来是新起点，不接 agent 链
      if (opts.dry) { console.log('==== SYSTEM ====\n' + frozenSystem + '\n==== USER ====\n' + user); console.log('[dry-run] 只看不说，不发客厅、不标已读、不写记忆'); run.status = 'dry'; return; }
      run.model_calls = 1;
      const first = unpackReply(await abortable(Promise.resolve(think(frozenSystem, user, signal)), signal)); addUsage(run, first.usage);
      let reply = first.text.trim();
      run.raw_reply = reply.slice(0, 2000);
      if (!reply && inbox.some(m => m.mentions && m.mentions.includes(room.id))) { fs.writeSync(2, `[${room.name}] 被叫了却回空，再试一次\n`); const again = unpackReply(await abortable(Promise.resolve(think(frozenSystem, user + '\n\n（上一次你回了空白。被叫了至少应一声。）', signal)), signal)); addUsage(run, again.usage); reply = again.text.trim(); run.model_calls = 2; run.raw_reply = reply.slice(0, 2000); }
      fs.writeSync(2, `[${room.name} 原始回复] ${reply.slice(0, 80).replace(/\n/g, ' ')}\n`);
      run.directives = [];
      { const lines = reply.split('\n'); const keep = [];
        let pinned = false;
        for (const l of lines) {
          if (/^\s*SUB[:：]/i.test(l)) {                                   // subagent V0：派子任务；解析在 adapter（与 PIN 同层）
            run.directives.push({ k: 'SUB', t: l.trim().slice(0, 200) });
            if (!subruns) { run.sub_error = (run.sub_error ? run.sub_error + '；' : '') + '本 runtime 不支持 SUB:'; fs.writeSync(2, `[${room.name} subrun] 丢弃 SUB:（${subCfg.enabled ? 'runtime 无 callOnce' : 'subagent 未启用'}）\n`); continue; }
            const spec = parseSubLine(l, { inbox, recentCtx, inheritMax: subCfg.inherit_max_chars || 12000 });
            if (!spec) { run.sub_error = (run.sub_error ? run.sub_error + '；' : '') + `看不懂或缺 带上:：${l.trim().slice(0, 80)}`; fs.writeSync(2, `[${room.name} subrun] SUB 看不懂或缺 带上:，没派\n`); continue; }
            try { const { sub_id } = subruns.start({ ...spec, system: soul }); run.sub_started = [...(run.sub_started || []), sub_id]; fs.writeSync(2, `[${room.name} subrun] 派了 ${sub_id}「${spec.task.slice(0, 60)}」\n`); }
            catch (e) { run.sub_error = (run.sub_error ? run.sub_error + '；' : '') + String(e.message).slice(0, 120); fs.writeSync(2, `[${room.name} subrun] 没派：${e.message}\n`); }
            continue;
          }
          if (/^\s*PIN(\s|[:：])/i.test(l)) {                               // 黑板（W7）：钉 → POST /tasks；改 → PATCH /tasks/:id。失败不炸整轮，记 run.pin_error
            const pin = BB.parsePin(l, { tz: R.tz }); run.directives.push({ k: 'PIN', t: l.trim().slice(0, 200) });
            if (!pin) { run.pin_error = (run.pin_error ? run.pin_error + '；' : '') + `看不懂：${l.trim().slice(0, 80)}`; fs.writeSync(2, `[${room.name} 黑板] PIN 看不懂，没登记：${l.trim().slice(0, 80)}\n`); continue; }
            if (pin.due_error) { run.pin_error = (run.pin_error ? run.pin_error + '；' : '') + `到期看不懂，照钉没带到期：${pin.due_error.slice(0, 60)}`; fs.writeSync(2, `[${room.name} 黑板] 到期看不懂（${pin.due_error.slice(0, 60)}），照钉不带到期\n`); }
            try {
              const origin = [...inbox].reverse().find(m0 => m0.kind === 'dm' || (m0.mentions && m0.mentions.includes(room.id))) || inbox[inbox.length - 1];
              const r = pin.op === 'pin' ? await api('POST', '/tasks', { title: pin.title, accept: pin.accept, owner: pin.owner || 'me', due_at: pin.due_at, due_cron: pin.due_cron, ...(origin ? { origin_message_id: origin.id } : {}) })
                : await api('PATCH', '/tasks/' + pin.id, { state: pin.state, ...(pin.text ? (pin.state === 'done' ? { result: pin.text } : { notes: pin.text }) : {}) });
              if (!r || !r.id) throw new Error(JSON.stringify(r).slice(0, 200));
              pinned = true; fs.writeSync(2, `[${room.name} 黑板] ${pin.op === 'pin' ? `钉了 ${r.id}「${r.title}」给 ${r.owner}` : `${r.id} → ${r.state}`}\n`);
            } catch (e) { run.pin_error = (run.pin_error ? run.pin_error + '；' : '') + String(e.message).slice(0, 200); fs.writeSync(2, `[${room.name} 黑板] PIN 没登记：${run.pin_error.slice(-200)}\n`); }
            continue; }
          const m = l.match(/^\s*(REMEMBER|CONCERN|DONE|NOTE|FORGET)[:：]\s*(.+)$/);
          if (!m) { keep.push(l); continue; } const [, k, t] = m; run.directives.push({ k, t: t.slice(0, 200) });
          if (k === 'REMEMBER' && R.memory) { R.memory.remember({ content: t, source: 'self', by: room.id }); console.log(`[${room.name} 记住] ${t.slice(0, 60)}`); }
          else if (k === 'CONCERN') { R.keys.concern(t); console.log(`[${room.name} 惦记] ${t.slice(0, 60)}`); }
          else if (k === 'DONE') { const g = R.keys.done(t); console.log(`[${room.name} 划掉] ${g ? g.slice(0, 60) : '（没对上）'}`); }
          else if (k === 'NOTE') { R.keys.note(t); console.log(`[${room.name} 备注] ${t.slice(0, 60)}`); }
          else if (k === 'FORGET' && R.memory) { const f = R.memory.forget(t); console.log(`[${room.name} 冷藏] ${f ? f.content.slice(0, 60) : '（没对上）'}`); }
          else keep.push(l); }
        if (pinned) syncTasks(await fetchTasks());                          // 刚钉/刚改的，routine 立刻跟上（做完的闹钟当场拆掉）
        reply = keep.join('\n').trim(); }
      if (inbox.length) { const a = await api('POST', '/inbox/ack', { ids: inbox.map(m => m.id) }); if (!a || typeof a.acked !== 'number') { run.ack_error = JSON.stringify(a).slice(0, 300); fs.writeSync(2, `[${room.name}] 标已读失败，下次会重复读到这些话：${run.ack_error}\n`); } }
      if (!reply || /^[(（]静默[)）]/.test(reply)) {                        // "(静默)" 后面再跟解释也算静默（实现员 46 次把"(静默)\n\n我还在读…"发进了客厅），解释只记进 run 不发
        const note = reply.replace(/^[(（]静默[)）]\s*/, '').trim(); if (note) run.silent_note = note.slice(0, 300);
        console.log(`[静默] 原始长度 ${String(reply || '').length}${note ? '，附了解释，不发' : ''}`); run.status = 'silent'; if (mailbox && mailItems.length) { mailMarked = true; mailbox.markAttempt(mailItems.map(i => i.id), 'silent', true); } return; }
      if (reply.startsWith('DM:')) { const m = reply.match(/^DM:\s*(\S+)\s*[:：]?\s*([\s\S]*)$/); if (m) { const dmR = await api('POST', '/dm', { to: m[1], text: m[2], hop: hopOut }); const dmOk = ok2xx(dmR, 'id'); if (mailbox && mailItems.length) { mailMarked = true; mailbox.markAttempt(mailItems.map(i => i.id), dmOk ? 'dm' : 'dm_failed', dmOk); } if (!dmOk) { run.status = 'dm_failed'; run.error = JSON.stringify(dmR).slice(0, 200); fs.writeSync(2, `[${room.name}] 私信没发出去（${dmR && dmR.$status}）：${run.error}\n`); return; } run.status = 'dm'; run.said = m[2].slice(0, 500); run.to = m[1]; return; } }
      if (/^APPROVAL[:：]/.test(reply)) {                                   // 两阶段（GATEWAY.md §2.1）：先向网关登记不可变 intent，再把 approval_body 原样交客厅，这轮到此结束；网关不可用就不发审批
        run.said = reply.slice(0, 500);
        let intent; try { intent = gw.parseApprovalLine(reply); }
        catch (e) { run.status = 'approval_invalid'; run.error = String(e.message).slice(0, 300); fs.writeSync(2, `[${room.name}] APPROVAL 格式不对（${run.error}），没登记：${reply.slice(0, 200).replace(/\n/g, ' ')}\n`); shift.push({ at: new Date().toISOString(), heard: inbox.map(m => `${m.from}：${m.text}`), said: '（你上一轮的 APPROVAL 格式不对：要 APPROVAL: <action> <JSON 参数>，没登记）' }); return; }
        let reg; try { reg = await gw.registerIntent({ residentId: room.id, runId: run.id, action: intent.action, params: intent.params, ttl: 1800 }); }
        catch (e) { run.status = 'gateway_unavailable'; run.error = `${e.code || 'GATEWAY-UNAVAILABLE'}: ${String(e.message).slice(0, 200)}`; fs.writeSync(2, `[${room.name}] 网关不可用，审批没登记（${run.error}）\n`); shift.push({ at: new Date().toISOString(), heard: inbox.map(m => `${m.from}：${m.text}`), said: `（你想 ${intent.action}，但网关不可用，没登记：${run.error.slice(0, 80)}）` }); return; }
        const a = await api('POST', '/approval', reg.approval_body);
        if (!a || !a.approval_id) { if (mailbox && mailItems.length) { mailMarked = true; mailbox.markAttempt(mailItems.map(i => i.id), 'approval_rejected', false); } run.status = 'approval_rejected'; run.error = '客厅没收审批：' + JSON.stringify(a).slice(0, 300); fs.writeSync(2, `[${room.name}] ${run.error}\n`); return; }
        run.status = 'approval'; run.gateway_request_id = reg.request_id; run.approval_id = a.approval_id; run.action = intent.action;
        if (mailbox && mailItems.length) { mailMarked = true; mailbox.markAttempt(mailItems.map(i => i.id), 'approval', true); }   // 客厅收了审批才算消费（gateway 登记成功不够）
        console.log(`[${room.name} 审批] ${intent.action} → ${a.approval_id}（${reg.request_id}）`); return; }
      const sayR = await api('POST', '/say', { text: reply, hop: hopOut }); const sayOk = ok2xx(sayR, 'id'); if (mailbox && mailItems.length) { mailMarked = true; mailbox.markAttempt(mailItems.map(i => i.id), sayOk ? 'say' : 'say_failed', sayOk); } if (!sayOk) { run.status = 'say_failed'; run.error = JSON.stringify(sayR).slice(0, 200); fs.writeSync(2, `[${room.name}] 没说出去（${sayR && sayR.$status}）：${run.error}\n`); return; } console.log(`[${room.name} 说] ${reply.slice(0, 80)}`); run.status = 'said'; run.said = reply.slice(0, 500);
      shift.push({ at: new Date().toISOString(), heard: inbox.map(m => `${m.from}：${m.text}`), said: reply });
    } catch (e) {
      if (signal && signal.aborted) { run.status = 'interrupted'; run.error = String((signal.reason && signal.reason.message) || signal.reason || e.message).slice(0, 300); console.log(`[打断] ${run.error}（这轮不标已读，下轮重读）`); }
      else { console.error('[醒来失败]', e.message); run.status = 'error'; run.error = String(e.message || e).slice(0, 300); }
    }
    finally {
      // 兜底（审查员 P1-2）：这一轮读了 mailbox 却没有任何出口标记（早 return：gateway_unavailable / approval_invalid / nothing / deferred / 异常）→ 记一次未消费的尝试，下次重放
      try { if (mailbox && !mailMarked && mailItems.length) mailbox.markAttempt(mailItems.map(i => i.id), run.status, false); } catch {}
      run.ms = Date.now() - t0; R.recordRun(run);
      if (hb && lane !== 'routine') hb.backoff(reason === 'heartbeat' && ['passive_idle', 'silent', 'nothing', 'passive_budget'].includes(run.status));   // 例行是定时的，不算"有真事"，不归零心跳退避
    }
  }
  async function writeHandover() {
    const hoDir = path.join(R.roomDir, 'handover'); fs.mkdirSync(hoDir, { recursive: true });
    const hoPath = path.join(hoDir, 'latest.md');
    const facts = shift.length ? shift.map(s => `- ${s.at.slice(11, 16)} 听到：${s.heard.join(' / ').slice(0, 200)}\n  我说：${s.said.slice(0, 200)}`).join('\n') : '- no interactions this session。';
    const render = note => `# 交接信 · ${room.name}\n\n写于 ${R.houseTime().replace('【时间】', '')}\n\n## 我想对明天的自己说\n${note || '（这一班没来得及写，看下面的事实）'}\n\n## 房子记下的事实\n${facts}\n`;
    fs.writeFileSync(hoPath, render(''));                       // 先把事实落盘（checkpoint 是底）
    console.log(`[${room.name}] 交接信·事实已写`);
    if (shift.length && !opts.dry) {                            // 再让本人补一句（交接信是面）
      try { const raw = await think(`你是${room.name}。现在要睡了，给明天醒来的自己写两三句交接信：这一班发生了什么、你惦记什么、有什么没做完。像给自己留便条，不要客套。`, `这一班的事实：\n${facts}`);
        const note = unpackReply(raw).text.trim();
        fs.writeSync(2, `[${room.name}] 便条原文长度 ${note.length}\n`);
        if (note) { fs.writeFileSync(hoPath, render(note)); fs.writeSync(2, `[${room.name}] 交接信·便条已写\n`); } } catch (e) { fs.writeSync(2, `[便条没写成] ${e && e.stack || e}\n`); }
    }
    fs.appendFileSync(path.join(hoDir, 'history.md'), fs.readFileSync(hoPath, 'utf8') + '\n---\n');
  }
  let sleeping = false;
  const sleep = async () => { if (sleeping) return; sleeping = true; try { await writeHandover(); } catch (e) { fs.writeSync(2, `[交接信失败] ${e.message}\n`); } try { if (think.shift && think.shift.archive) think.shift.archive(); } catch (e) { fs.writeSync(2, `[shift归档失败] ${e.message}\n`); } try { if (R.memory && R.memory.compact) R.memory.compact(); } catch (e) { fs.writeSync(2, `[记忆 compact 失败] ${e.message}\n`); } state.last_sleep = new Date().toISOString(); save(); try { await api('POST', '/activity', { kind: 'sleep', text: `${room.name}：session ended, handover saved`, meta: { wakes_today: state.wakes_today } }); } catch {} };
  // 统一收尾（审查员 P1-1）：SIGINT/SIGTERM 与测试 signal 走同一条路：stopped → subruns.stop → SSE/timer/active → sleep。不直接 process.exit 越过 manager。
  let shutdownP = null;
  const shutdown = () => shutdownP || (shutdownP = (async () => {
    stopped = true;
    if (subruns) { try { const left = await subruns.stop(5000); if (left) fs.writeSync(2, `[${room.name} subrun] 收尾超时，${left} 个子任务未在 5s 内停下\n`); } catch (e) { fs.writeSync(2, `[${room.name} subrun] 收尾失败：${e.message}\n`); } }
    try { clearTimeout(sseTimer); if (sseReq) sseReq.destroy(); } catch {}
    try { if (rtTimer) clearInterval(rtTimer); if (hb) hb.stop(); } catch {}
    if (active) active.ctrl.abort(new Error('适配器停下了'));
    for (let i = 0; i < 100 && active; i++) await new Promise(r => setTimeout(r, 50));   // 等正在跑的这一轮收尾（最多 5 秒）
    await sleep();
  })());
  process.on('SIGINT', async () => { await shutdown(); process.exit(0); }); process.on('SIGTERM', async () => { await shutdown(); process.exit(0); });
  let sseReq = null, sseTimer = null, rtTimer = null;   // 提前声明：shutdown 会引用
  // 启动恢复（审查员 P1-1）：必须在首次 wake 和 SSE 之前，否则启动 inbox 里迟到的子任务结果会先泄漏进 prompt；与是否传测试 signal 无关
  if (subruns) { try { const r = await subruns.recoverOnStartup(id => gw.getIntent(room.id, id), 10); if (r.interrupted) fs.writeSync(2, `[${room.name} subrun] 启动恢复：${r.interrupted} 个被中断的子任务已入 mailbox\n`); } catch (e) { fs.writeSync(2, `[${room.name} subrun] 启动恢复失败：${e.message}\n`); } }
  console.log(`[${room.name}] 适配器上线，runtime=${runtimeName}，客厅=${lrBase}${opts.dry ? '，dry-run' : ''}`);
  await refreshMembers();
  for (let i = 0; i < 30; i++) { try { const m = await api('GET', '/members'); if (Array.isArray(m)) break; } catch {} await new Promise(r => setTimeout(r, 500)); }   // 客厅可能还在开门（systemd 一起拉起时 adapter 早 1 秒），最多等 15 秒
  syncTasks(await fetchTasks());                                          // 启动先把黑板上的 due 落成 routine（进程没跑时错过的按 late_grace 补响）
  await requestWake('human', '启动时看看有没有人找我');
  if (opts.once || opts.dry) { await sleep(); return; }
  const u = new URL('/events', lrBase);
  const resub = ms => { if (!stopped) sseTimer = setTimeout(sub, ms); };
  const sub = () => { if (stopped) return; const req = sseReq = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { authorization: `Bearer ${JSON.parse(fs.readFileSync(path.join(RUN, 'living-room-tokens.json'), 'utf8'))[room.id]}` } }, res => {
    let buf = ''; res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); if (!chunk.startsWith('data:')) continue; try { const m = JSON.parse(chunk.slice(5)); onMessage(m); } catch {} } });
    res.on('end', () => resub(3000)); }); req.on('error', () => resub(5000)); req.end(); };
  function onMessage(m) {
    if (!m || m.type === 'activity' || m.from_id === room.id) return;
    if (m.kind === 'result') { if (subOwns(m)) { subruns.noteDelivered(m.meta.request_id); return; } if (m.to_id === room.id) requestWake('human', '网关结果：' + ((m.meta || {}).status || '?'), 'interrupt'); return; }   // 合同 B（第一处）：子任务的结果不打断   // 网关结果：合同要求 human 车道醒（GATEWAY.md §3.3）
    if (!((m.mentions || []).includes(room.id) || m.kind === 'dm')) return;
    if (!memberById(m.from_id)) refreshMembers();                                   // 新面孔，下轮再认
    const human = isHuman(m.from_id); const who = byName(m.from_id, members);
    const hop = Number((m.meta || {}).hop) || 0;
    if (!human && hop >= limits.agent_hops) { fs.writeSync(2, `[${room.name}] ${who} 叫我，但这条 agent 链已 ${hop} 跳，只记不醒（上限 ${limits.agent_hops}）\n`); return; }
    requestWake(human ? 'human' : 'agent', `${who} 叫我`, resolveDeliver(m));
  }
  sub();
  // ---- 例行：每 30 秒看一眼，到点的按 routine 车道醒。cron 型进程没跑时错过的不补跑，只在启动时记一行；
  // at 型是一次性提醒，错过就没了，所以启动后 late_grace（默认 24h）内的补响一次，超过的只记一行"错过太久不补"。
  // 心跳自身逻辑不动：due() 基于 state.last_run_at，例行跑过后心跳自然往后推——"心跳不再背定时的事"就是这个意思。
  {
    const now = new Date();
    for (const r of routines) { const n = countMissed(r, state, now, R.tz); if (!n) continue;
      if (r.at) { const st = state.routines[r.id] = state.routines[r.id] || {}; if (st.missed) continue;   // 记一次就安静，别每次启动都嚷
        st.missed = true; st.missed_at = now.toISOString(); save();
        fs.writeSync(2, `[${room.name}] 例行 ${r.id} 原定 ${fmtAt(atMs(r), R.tz)}，已过 ${Math.round((now.getTime() - atMs(r)) / 3600000)} 小时，超过 late_grace，错过太久不补（已记 missed，改大 late_grace 也不会再响；要重发就换个 id）\n`); }
      else fs.writeSync(2, `[${room.name}] 例行 ${r.id} 上次触发 ${state.routines[r.id].last_fired} 之后错过 ${n} 次，不补跑\n`); }
    const rtick = () => {
      const now = new Date();
      for (const r of routines) {
        const key = dueNow(r, state, now, R.tz); if (!key) continue;
        const st = state.routines[r.id] = state.routines[r.id] || { last_fired: null, skipped_quiet: 0, fired: 0 };
        if (r.quiet_hours === 'respect' && R.inQuiet()) {
          if (r.at) { if (!st.held_quiet) { st.held_quiet = true; save(); fs.writeSync(2, `[${room.name}] 例行 ${r.id}（一次性）赶上安静时段，等过了再响\n`); } continue; }   // 一次性的不跳过，压着等；grace 内没等到就算了
          st.last_fired = key; st.skipped_quiet = (st.skipped_quiet || 0) + 1; save(); fs.writeSync(2, `[${room.name}] 例行 ${r.id} 赶上安静时段，跳过\n`); continue; }
        st.last_fired = key; st.fired = (st.fired || 0) + 1;
        if (r.at) { st.done = true; st.fired_at = now.toISOString(); if (now.getTime() - atMs(r) > 90000) fs.writeSync(2, `[${room.name}] 例行 ${r.id} 原定 ${fmtAt(atMs(r), R.tz)}，晚了 ${Math.round((now.getTime() - atMs(r)) / 60000)} 分钟，补响\n`); }
        save();
        requestWake('routine', `routine:${r.id}`);
      }
    };
    rtick(); rtTimer = setInterval(rtick, 30000); if (rtTimer.unref) rtTimer.unref();   // 黑板会往 routines 里加减，所以 tick 一直装着（数组空也装）
    if (routines.length) console.log(`[${room.name}] 例行 ${routines.length} 条：${routines.map(r => `${r.id}(${r.at ? 'at ' + fmtAt(atMs(r), R.tz) + ((state.routines[r.id] || {}).done ? '，已响过' : '') : r.cron}${r.enabled ? '' : '，停用'})`).join('、')}`);
  }
  // ---- 心跳：下次 = 上次醒来（任何原因）+ 间隔；连续空心跳才退避（×1.5 到 4 小时），有真事就归位；忙则推迟不叠加；安静时段跳过 ----
  const hbCfg = room.heartbeat || (R.house.defaults || {}).heartbeat || {};
  if (hbCfg.enabled !== false) {
    const base = (Number(hbCfg.interval) > 0 ? Number(hbCfg.interval) : 60) * 60000; let iv = base; let timer = null;
    const due = () => (state.last_run_at ? new Date(state.last_run_at).getTime() : Date.now()) + iv;
    const tick = () => {
      if (active) { hb.reschedule(); return; }
      if (R.inQuiet()) { hb.backoff(true); hb.reschedule(); return; }
      requestWake('heartbeat', 'heartbeat');
    };
    hb = {
      reschedule() { clearTimeout(timer); const wait = Math.max(5000, due() - Date.now()); timer = setTimeout(tick, wait); if (timer.unref) timer.unref(); },
      backoff(empty) { iv = empty ? Math.min(iv * 1.5, 4 * 3600000) : base; },
      stop() { clearTimeout(timer); },
    };
    hb.reschedule();
  }
  if (!stop) return;                                                    // 没给 signal：循环靠 SSE 连接与 timer 活着；SIGINT/SIGTERM 走上面的 shutdown()
  await new Promise(resolve => { if (stop.aborted) return resolve(); stop.addEventListener('abort', resolve, { once: true }); });
  await shutdown();
}
module.exports = { parseSubLine, mergeSubagentConfig, open, run, houseRoot, get HOUSE() { return houseRoot(); }, RUN, LANE, mergeRoutines, dueNow, countMissed, renderInboxLine, parseApprovalLine: gw.parseApprovalLine, parsePin: BB.parsePin, syncTaskRoutines: BB.syncTaskRoutines };
