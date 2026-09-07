// 同屋 · 适配器公共件：读房间、连客厅、房子供给时间、醒/睡循环。运行时只需实现 think(system,user)→reply。
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const yaml = require('js-yaml');
const { resolveHouseRoot } = require('@sameroof/house-root');
const memoryPlugin = require('@sameroof/plugin-memory');
const cron = require('./cron');
const C = require('./context');                                          // 上下文拼装的纯函数：打分挑选、摘要帧、工具留壳
const gw = require('./gateway-client');
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
function open(roomName) {
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
  const api = (method, p, body) => new Promise((resolve, reject) => {
    const u = new URL(p, LR);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { authorization: `Bearer ${lrToken}`, 'content-type': 'application/json' } }, res => { let s = ''; res.on('data', c => s += c); res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(s); } }); });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
  const tz = (room.schedule && room.schedule.timezone && room.schedule.timezone !== 'inherit') ? room.schedule.timezone : house.timezone;
  const houseTime = () => {
    const now = new Date(); const fmt = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(now);
    const slept = state.last_sleep ? Math.round((now - new Date(state.last_sleep)) / 60000) : null;
    return `【房子供给的时间】现在是 ${fmt}（${tz}）。` + (state.last_sleep ? `你上次睡是 ${state.last_sleep}，睡了约 ${slept} 分钟。` : '这是你在这间屋子里第一次醒来。') + ` 今天你已醒来 ${state.wakes_today} 次。`;
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
    const brief = (rec.lane === 'routine' && { said: '例行的事，说了一句', silent: '例行看过了，没什么要说' }[rec.status]) || { said: '说了一句', dm: '发了私信', approval: '请求了审批', approval_invalid: 'APPROVAL 格式不对，没登记', gateway_unavailable: '网关不可用，审批没登记', approval_rejected: '客厅没收审批', silent: '看了看，没说话', error: '出错了', passive_budget: '预算用完，只看不说', passive_idle: '心跳，没事', nothing: '醒了，没人找', deferred: '有新话但没叫我', dry: 'dry-run' }[rec.status] || rec.status;
    const kind = rec.status === 'error' ? 'error' : (rec.model_calls ? 'model_call' : 'wake');
    api('POST', '/activity', { kind, text: `${room.name}：${brief}`, meta: { run_id: rec.id, reason: rec.reason, status: rec.status, ms: rec.ms, usage: rec.usage || null, model_calls: rec.model_calls || 0, error: rec.error || null } }).catch(() => {}); };
  const plugins = room.plugins || (house.defaults || {}).plugins || [];
  const memory = plugins.includes('memory') ? memoryPlugin.open(roomDir) : null;
  return { room, house, roomDir, api, houseTime, inQuiet, budgetLeft, state, save, soul, memory, keys, recordRun, tz };
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
// ---- 例行（routines）：house/room 的 extensions["dev.sameroof.routines"]，每条 { id, cron, prompt, enabled?, quiet_hours? } ----
// 房间的追加在房子之后，同 id 房间覆盖房子。字段缺、cron 非法、同一处 id 重复都直接抛（配置小，早炸早改）。
function mergeRoutines(house, room) {
  const list = (o, where) => { const raw = ((o || {}).extensions || {})['dev.sameroof.routines'] || []; if (!Array.isArray(raw)) throw new Error(`${where} 的 routines 得是数组`);
    const seen = new Set(); return raw.map((r, i) => {
      if (!r || typeof r.id !== 'string' || !r.id) throw new Error(`${where} routines[${i}] 缺 id`);
      if (seen.has(r.id)) throw new Error(`${where} routines 里 id 重复：${r.id}`); seen.add(r.id);
      if (typeof r.prompt !== 'string' || !r.prompt.trim()) throw new Error(`${where} routine ${r.id} 缺 prompt`);
      cron.parse(r.cron);
      return { id: r.id, cron: r.cron, prompt: r.prompt.trim(), enabled: r.enabled !== false, quiet_hours: r.quiet_hours === 'respect' ? 'respect' : 'ignore' }; }); };
  const out = new Map(); for (const r of [...list(house, 'house.yaml'), ...list(room, 'room.yaml')]) out.set(r.id, r);
  return [...out.values()];
}
// 这一分钟该不该触发：匹配 cron 且这一分钟（按 tz 的 'YYYY-MM-DDTHH:MM' 键）没触发过。返回键或 null，不改 state。
function dueNow(routine, state, now = new Date(), tz = 'UTC') {
  if (!routine.enabled) return null;
  const t = cron.parts(now, tz); if (!cron.matches(routine.cron, now, tz)) return null;
  const st = ((state || {}).routines || {})[routine.id] || {};
  return st.last_fired === t.key ? null : t.key;
}
// 上次触发到现在之间错过了几次（进程没跑时的），只用来在启动时记一行；最多往回数 cap 分钟
function countMissed(routine, state, now = new Date(), tz = 'UTC', cap = 7 * 24 * 60) {
  const st = ((state || {}).routines || {})[routine.id] || {}; if (!st.last_fired) return 0;
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

async function run(roomName, runtimeName, think, opts = {}) {
  const R = open(roomName); const { room, api, state, save, soul } = R;
  // ---- 地基配置（先放 extensions.dev.sameroof.*，等审查员升核心字段）----
  const ext = k => (((R.house.extensions || {})['dev.sameroof.' + k]) || {});
  const rext = k => (((room.extensions || {})['dev.sameroof.' + k]) || {});
  const limits = Object.assign({ run_timeout_ms: 180000, agent_hops: 6 }, ext('limits'), rext('limits'));
  const deliverCfg = Object.assign({ human: 'after_turn', agent: 'after_turn', from: {} }, ext('deliver'), rext('deliver'),
    { from: Object.assign({}, (ext('deliver').from || {}), (rext('deliver').from || {})) });
  const routines = mergeRoutines(R.house, room); state.routines = state.routines || {};
  const routineById = id => routines.find(r => r.id === id);
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
  function requestWake(lane, reason, deliver = 'after_turn') {
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
  function pump() { for (const lane of LANES) { const r = lane === 'routine' ? pending.routine.shift() : pending[lane]; if (!r) continue; if (lane !== 'routine') pending[lane] = null; runOnce(lane, r); return; } }
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
    const routine = lane === 'routine' ? routineById(reason.replace(/^routine:/, '')) : null; if (routine) run.routine_id = routine.id;
    const t0 = Date.now();
    try {
      if (!R.budgetLeft()) { console.log('[预算] 今日请求数用完，passive'); run.status = 'passive_budget'; return; }
      const inbox = await api('GET', '/inbox'); if (!Array.isArray(inbox)) throw new Error('客厅没开门: ' + JSON.stringify(inbox));
      // 例行醒来：inbox 空也不算 nothing，没 @ 我也不 deferred——例行本来就不是因为有人叫
      if (!routine && inbox.length === 0 && reason !== 'heartbeat') { run.status = 'nothing'; return; }
      if (!routine && reason !== 'heartbeat' && !inbox.some(m => m.kind === 'dm' || (m.mentions && m.mentions.includes(room.id)))) { console.log('[醒] 有新话但没叫我，留到心跳再看'); run.status = 'deferred'; return; }
      if (inbox.length === 0 && reason === 'heartbeat') {
        if (!R.keys.concerns().length) { console.log('[心跳] 没人叫我，惦记本也是空的，不叫模型'); run.status = 'passive_idle'; return; }
      }
      await refreshMembers();
      const hoPath = path.join(R.roomDir, 'handover', 'latest.md'); const handover = fs.existsSync(hoPath) ? fs.readFileSync(hoPath, 'utf8') : '（没有交接信）';
      state.wakes_today++; state.last_wake = new Date().toISOString(); save();
      // ---- 上下文预算（房间可配，缺省来自 house.yaml defaults.context）----
      const ctx = Object.assign({ recent_messages: 20, recent_max_chars: 4000, memory_hits: 4, memory_recent: 3, frame_max_chars: 400 },
        ((R.house.defaults || {}).context) || ((R.house.extensions || {})['dev.sameroof.context']) || {},
        room.context || ((room.extensions || {})['dev.sameroof.context']) || {});
      let remembered = '';
      if (R.memory) {
        const q = inbox.map(m => m.text).join(' ') || handover;
        const hits = R.memory.recall(q, ctx.memory_hits); const recent = R.memory.recent(ctx.memory_recent).filter(m => !hits.find(h => h.id === m.id));
        const list = [...hits, ...recent]; if (list.length) remembered = '【我记得的事】\n' + R.memory.render(list);
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
      if (ctx.recent_messages > 0) {
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
          const h = await api('GET', `/dm/history?with=${encodeURIComponent(pid)}&limit=${Math.min(200, pool + inbox.length)}`).catch(() => []);
          const rows = (Array.isArray(h) ? h : []).filter(m => !unreadIds.has(m.id)).slice(-pool);
          if (!rows.length) continue;
          const r = pick(rows, n, ctx.dm_max_chars || 3000, 'long');
          if (r.lines.length) blocks.push(`【和 ${byName(pid, members)} 的私信往来（你已经回过的，别再回一遍）】\n` + r.lines.join('\n'));
        }
        dmCtx = blocks.join('\n');
      }
      // ---- 提示按"变化频率"排：system 只放一班内稳定的（人设、规矩、交接信、惦记本、小本）----
      const system = [
        soul || `你是${room.name}。`,
        '',
        '【这是客厅，不是对话框】你是这个家里的一个人，不是谁的助手。屋里的人（人和 agent）都在，你听到的话不一定是对你说的。',
        '- 想叫谁就在话里写 @名字（可以叫其他 agent，他们会醒来看）。没被叫的话你可以接，也可以不接。',
        '- 一次可以只回一个人；几个人说了话，回的时候说清楚回的是谁。',
        '- 家里的人（human）直接 @ 了你，至少应一声，哪怕就一句。(静默) 是给没被叫的时候用的。',
        '- 不想让全家看见就私信：整条回复以 DM: 收件人 开头。',
        '- 你只搬字，不能执行命令。要做高危动作（读写文件、跑命令），整条回复只写一行：APPROVAL: <action> <JSON 参数>，房子会登记到网关等人审批，结果以"网关结果"投回你的收件箱。例：APPROVAL: core.fs.write {"root_id":"own-room","path":"notes/today.md","content":"今天的记录…","encoding":"utf8","mode":"replace"}（动作有 core.fs.read / core.fs.write / core.exec；参数必须是严格 JSON 对象，键不重复，别夹别的字）。',
        R.memory ? '- 值得以后还记得的事，在回复末尾另起一行写 REMEMBER: 一句话（可多行）。房子会存下来，标记为你自己写的、未审。' : '',
        '- 你自己房间的钥匙（同样另起一行）：CONCERN: 一句话 记进惦记本；DONE: 一句话 划掉做完的；NOTE: 一句话 记在自己的小本上；' + (R.memory ? 'FORGET: 一句话 把记忆里对上的那条冷藏（不删）。' : ''),
        '',
        '【上次交接信】', handover,
        R.keys.concerns().length ? '【我惦记的事】\n' + R.keys.concerns().join('\n') : '',
        R.keys.notes().length ? '【我自己的小本】\n' + R.keys.notes().join('\n') : '',
      ].filter(x => x !== '').join('\n');
      // 每次醒都变的一律放 user：时间、在场的人、为什么醒、召回、刚才的话、私信往来、未读。system 一班内基本不动，prompt cache 才吃得到。
      const wakeHead = [
        R.houseTime(),
        `【家里的人】${members.map(m => `${m.name}(${m.species}${m.online ? '·在线' : ''})`).join('、')}`,
        `【为什么醒】${reason}`,
        remembered, recentCtx, dmCtx,
      ].filter(x => x !== '').join('\n');
      const inboxText = '【你没读的客厅记录（按时间）】\n' + inbox.map(m => m.kind === 'result' ? renderInboxLine(m, room.id) : frame(m, 'short', `${m.kind === 'dm' ? '(私信给你)' : ''}${m.mentions && m.mentions.includes(room.id) ? '(叫了你)' : ''}`, 0)).join('\n');   // 未读不截断，只做工具留壳；网关结果单独渲染
      const user = wakeHead + '\n\n' + (routine ? `【例行】${routine.prompt}` + (inbox.length ? '\n\n' + inboxText : '') + '\n\n例行的事做完就说一句，没什么要说就回 (静默)。'
        : inbox.length ? inboxText + '\n\n看完决定：要不要说、对谁说。只回新的；上面"刚才的话"里已经有人回过的、你自己说过的，不要再回一遍。像家里人说话，不要列清单；没什么要说就回 (静默)。'
        : '心跳醒来。客厅没人叫你，但交接信里有惦记的事。要是确实该对家里人说一句就说，没有就回 (静默)。');
      run.heard = inbox.map(m => ({ id: m.id, from: m.from, kind: m.kind, text: m.text.slice(0, 300), mentioned: !!(m.mentions && m.mentions.includes(room.id)) }));
      run.context = { system_chars: system.length, user_chars: user.length, memories_recalled: remembered ? remembered.split('\n').length - 1 : 0, recent_lines: recentCtx ? recentCtx.split('\n').length - 1 : 0, dm_lines: dmCtx ? dmCtx.split('\n').length : 0, recent_scored: recentScored, system_preview: system.slice(0, 1200), user_preview: user.slice(0, 1200) };
      // 跳数：人说的话 hop=0；agent 回话 = 听到的 agent 消息里最大 hop + 1。超过上限的链只写不叫醒（防两个 agent 无限对聊）
      const hopIn = inbox.filter(m => !isHuman(m.from_id)).reduce((a, m) => Math.max(a, Number((m.meta || {}).hop) || 0), 0);
      const hopOut = (room.species === 'human' || routine) ? 0 : hopIn + 1;   // 例行醒来是新起点，不接 agent 链
      if (opts.dry) { console.log('==== SYSTEM ====\n' + system + '\n==== USER ====\n' + user); console.log('[dry-run] 只看不说，不发客厅、不标已读、不写记忆'); run.status = 'dry'; return; }
      run.model_calls = 1;
      let reply = await abortable(Promise.resolve(think(system, user, signal)), signal);
      reply = String(reply || '').trim();
      run.raw_reply = reply.slice(0, 2000);
      if (!reply && inbox.some(m => m.mentions && m.mentions.includes(room.id))) { fs.writeSync(2, `[${room.name}] 被叫了却回空，再试一次\n`); reply = String(await abortable(Promise.resolve(think(system, user + '\n\n（上一次你回了空白。被叫了至少应一声。）', signal)), signal) || '').trim(); run.model_calls = 2; run.raw_reply = reply.slice(0, 2000); }
      fs.writeSync(2, `[${room.name} 原始回复] ${reply.slice(0, 80).replace(/\n/g, ' ')}\n`);
      run.directives = [];
      { const lines = reply.split('\n'); const keep = [];
        for (const l of lines) { const m = l.match(/^\s*(REMEMBER|CONCERN|DONE|NOTE|FORGET)[:：]\s*(.+)$/);
          if (!m) { keep.push(l); continue; } const [, k, t] = m; run.directives.push({ k, t: t.slice(0, 200) });
          if (k === 'REMEMBER' && R.memory) { R.memory.remember({ content: t, source: 'self', by: room.id }); console.log(`[${room.name} 记住] ${t.slice(0, 60)}`); }
          else if (k === 'CONCERN') { R.keys.concern(t); console.log(`[${room.name} 惦记] ${t.slice(0, 60)}`); }
          else if (k === 'DONE') { const g = R.keys.done(t); console.log(`[${room.name} 划掉] ${g ? g.slice(0, 60) : '（没对上）'}`); }
          else if (k === 'NOTE') { R.keys.note(t); console.log(`[${room.name} 备注] ${t.slice(0, 60)}`); }
          else if (k === 'FORGET' && R.memory) { const f = R.memory.forget(t); console.log(`[${room.name} 冷藏] ${f ? f.content.slice(0, 60) : '（没对上）'}`); }
          else keep.push(l); }
        reply = keep.join('\n').trim(); }
      if (inbox.length) { const a = await api('POST', '/inbox/ack', { ids: inbox.map(m => m.id) }); if (!a || typeof a.acked !== 'number') { run.ack_error = JSON.stringify(a).slice(0, 300); fs.writeSync(2, `[${room.name}] 标已读失败，下次会重复读到这些话：${run.ack_error}\n`); } }
      if (!reply || /^[(（]静默[)）]/.test(reply)) {                        // "(静默)" 后面再跟解释也算静默（实现员 46 次把"(静默)\n\n我还在读…"发进了客厅），解释只记进 run 不发
        const note = reply.replace(/^[(（]静默[)）]\s*/, '').trim(); if (note) run.silent_note = note.slice(0, 300);
        console.log(`[静默] 原始长度 ${String(reply || '').length}${note ? '，附了解释，不发' : ''}`); run.status = 'silent'; return; }
      if (reply.startsWith('DM:')) { const m = reply.match(/^DM:\s*(\S+)\s*[:：]?\s*([\s\S]*)$/); if (m) { await api('POST', '/dm', { to: m[1], text: m[2], hop: hopOut }); run.status = 'dm'; run.said = m[2].slice(0, 500); run.to = m[1]; return; } }
      if (/^APPROVAL[:：]/.test(reply)) {                                   // 两阶段（GATEWAY.md §2.1）：先向网关登记不可变 intent，再把 approval_body 原样交客厅，这轮到此结束；网关不可用就不发审批
        run.said = reply.slice(0, 500);
        let intent; try { intent = gw.parseApprovalLine(reply); }
        catch (e) { run.status = 'approval_invalid'; run.error = String(e.message).slice(0, 300); fs.writeSync(2, `[${room.name}] APPROVAL 格式不对（${run.error}），没登记：${reply.slice(0, 200).replace(/\n/g, ' ')}\n`); shift.push({ at: new Date().toISOString(), heard: inbox.map(m => `${m.from}：${m.text}`), said: '（你上一轮的 APPROVAL 格式不对：要 APPROVAL: <action> <JSON 参数>，没登记）' }); return; }
        let reg; try { reg = await gw.registerIntent({ residentId: room.id, runId: run.id, action: intent.action, params: intent.params, ttl: 1800 }); }
        catch (e) { run.status = 'gateway_unavailable'; run.error = `${e.code || 'GATEWAY-UNAVAILABLE'}: ${String(e.message).slice(0, 200)}`; fs.writeSync(2, `[${room.name}] 网关不可用，审批没登记（${run.error}）\n`); return; }
        const a = await api('POST', '/approval', reg.approval_body);
        if (!a || !a.approval_id) { run.status = 'approval_rejected'; run.error = '客厅没收审批：' + JSON.stringify(a).slice(0, 300); fs.writeSync(2, `[${room.name}] ${run.error}\n`); return; }
        run.status = 'approval'; run.gateway_request_id = reg.request_id; run.approval_id = a.approval_id; run.action = intent.action;
        console.log(`[${room.name} 审批] ${intent.action} → ${a.approval_id}（${reg.request_id}）`); return; }
      await api('POST', '/say', { text: reply, hop: hopOut }); console.log(`[${room.name} 说] ${reply.slice(0, 80)}`); run.status = 'said'; run.said = reply.slice(0, 500);
      shift.push({ at: new Date().toISOString(), heard: inbox.map(m => `${m.from}：${m.text}`), said: reply });
    } catch (e) {
      if (signal && signal.aborted) { run.status = 'interrupted'; run.error = String((signal.reason && signal.reason.message) || signal.reason || e.message).slice(0, 300); console.log(`[打断] ${run.error}（这轮不标已读，下轮重读）`); }
      else { console.error('[醒来失败]', e.message); run.status = 'error'; run.error = String(e.message || e).slice(0, 300); }
    }
    finally {
      run.ms = Date.now() - t0; if (R.lastUsage) { run.usage = R.lastUsage; R.lastUsage = null; } R.recordRun(run);
      if (hb && lane !== 'routine') hb.backoff(reason === 'heartbeat' && ['passive_idle', 'silent', 'nothing', 'passive_budget'].includes(run.status));   // 例行是定时的，不算"有真事"，不归零心跳退避
    }
  }
  async function writeHandover() {
    const hoDir = path.join(R.roomDir, 'handover'); fs.mkdirSync(hoDir, { recursive: true });
    const hoPath = path.join(hoDir, 'latest.md');
    const facts = shift.length ? shift.map(s => `- ${s.at.slice(11, 16)} 听到：${s.heard.join(' / ').slice(0, 200)}\n  我说：${s.said.slice(0, 200)}`).join('\n') : '- 这一班没人叫我，我也没说话。';
    const render = note => `# 交接信 · ${room.name}\n\n写于 ${R.houseTime().replace('【房子供给的时间】', '')}\n\n## 我想对明天的自己说\n${note || '（这一班没来得及写，看下面的事实）'}\n\n## 房子记下的事实\n${facts}\n`;
    fs.writeFileSync(hoPath, render(''));                       // 先把事实落盘（checkpoint 是底）
    console.log(`[${room.name}] 交接信·事实已写`);
    if (shift.length && !opts.dry) {                            // 再让本人补一句（交接信是面）
      try { const raw = await think(`你是${room.name}。现在要睡了，给明天醒来的自己写两三句交接信：这一班发生了什么、你惦记什么、有什么没做完。像给自己留便条，不要客套。`, `这一班的事实：\n${facts}`);
        const note = String(raw || '').trim();
        fs.writeSync(2, `[${room.name}] 便条原文长度 ${note.length}\n`);
        if (note) { fs.writeFileSync(hoPath, render(note)); fs.writeSync(2, `[${room.name}] 交接信·便条已写\n`); } } catch (e) { fs.writeSync(2, `[便条没写成] ${e && e.stack || e}\n`); }
    }
    fs.appendFileSync(path.join(hoDir, 'history.md'), fs.readFileSync(hoPath, 'utf8') + '\n---\n');
  }
  let sleeping = false;
  const sleep = async () => { if (sleeping) return; sleeping = true; try { await writeHandover(); } catch (e) { fs.writeSync(2, `[交接信失败] ${e.message}\n`); } try { if (R.memory && R.memory.compact) R.memory.compact(); } catch (e) { fs.writeSync(2, `[记忆 compact 失败] ${e.message}\n`); } /* 睡前把追加的 update 行折平 */ state.last_sleep = new Date().toISOString(); save(); try { await api('POST', '/activity', { kind: 'sleep', text: `${room.name}：睡了，交接信已写`, meta: { wakes_today: state.wakes_today } }); } catch {} };
  process.on('SIGINT', async () => { await sleep(); process.exit(0); }); process.on('SIGTERM', async () => { await sleep(); process.exit(0); });
  console.log(`[${room.name}] 适配器上线，runtime=${runtimeName}，客厅=${LR}${opts.dry ? '，dry-run' : ''}`);
  await refreshMembers();
  for (let i = 0; i < 30; i++) { try { const m = await api('GET', '/members'); if (Array.isArray(m)) break; } catch {} await new Promise(r => setTimeout(r, 500)); }   // 客厅可能还在开门（systemd 一起拉起时 adapter 早 1 秒），最多等 15 秒
  await requestWake('human', '启动时看看有没有人找我');
  if (opts.once || opts.dry) { await sleep(); return; }
  const u = new URL('/events', LR);
  const sub = () => { const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { authorization: `Bearer ${JSON.parse(fs.readFileSync(path.join(RUN, 'living-room-tokens.json'), 'utf8'))[room.id]}` } }, res => {
    let buf = ''; res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); if (!chunk.startsWith('data:')) continue; try { const m = JSON.parse(chunk.slice(5)); onMessage(m); } catch {} } });
    res.on('end', () => setTimeout(sub, 3000)); }); req.on('error', () => setTimeout(sub, 5000)); req.end(); };
  function onMessage(m) {
    if (!m || m.type === 'activity' || m.from_id === room.id) return;
    if (m.kind === 'result') { if (m.to_id === room.id) requestWake('human', '网关结果：' + ((m.meta || {}).status || '?'), 'interrupt'); return; }   // 网关结果：合同要求 human 车道醒（GATEWAY.md §3.3）
    if (!((m.mentions || []).includes(room.id) || m.kind === 'dm')) return;
    if (!memberById(m.from_id)) refreshMembers();                                   // 新面孔，下轮再认
    const human = isHuman(m.from_id); const who = byName(m.from_id, members);
    const hop = Number((m.meta || {}).hop) || 0;
    if (!human && hop >= limits.agent_hops) { fs.writeSync(2, `[${room.name}] ${who} 叫我，但这条 agent 链已 ${hop} 跳，只记不醒（上限 ${limits.agent_hops}）\n`); return; }
    requestWake(human ? 'human' : 'agent', `${who} 叫我`, resolveDeliver(m));
  }
  sub();
  // ---- 例行：每 30 秒看一眼，到点的按 routine 车道醒。进程没跑时错过的不补跑，只在启动时记一行。
  // 心跳自身逻辑不动：due() 基于 state.last_run_at，例行跑过后心跳自然往后推——"心跳不再背定时的事"就是这个意思。
  if (routines.length) {
    const now = new Date();
    for (const r of routines) { const n = countMissed(r, state, now, R.tz); if (n) fs.writeSync(2, `[${room.name}] 例行 ${r.id} 上次触发 ${state.routines[r.id].last_fired} 之后错过 ${n} 次，不补跑\n`); }
    const rtick = () => {
      const now = new Date();
      for (const r of routines) {
        const key = dueNow(r, state, now, R.tz); if (!key) continue;
        const st = state.routines[r.id] = state.routines[r.id] || { last_fired: null, skipped_quiet: 0, fired: 0 };
        st.last_fired = key;
        if (r.quiet_hours === 'respect' && R.inQuiet()) { st.skipped_quiet = (st.skipped_quiet || 0) + 1; save(); fs.writeSync(2, `[${room.name}] 例行 ${r.id} 赶上安静时段，跳过\n`); continue; }
        st.fired = (st.fired || 0) + 1; save();
        requestWake('routine', `routine:${r.id}`);
      }
    };
    rtick(); const rt = setInterval(rtick, 30000); if (rt.unref) rt.unref();
    console.log(`[${room.name}] 例行 ${routines.length} 条：${routines.map(r => `${r.id}(${r.cron}${r.enabled ? '' : '，停用'})`).join('、')}`);
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
    };
    hb.reschedule();
  }
}
module.exports = { open, run, houseRoot, get HOUSE() { return houseRoot(); }, RUN, LANE, mergeRoutines, dueNow, countMissed, renderInboxLine, parseApprovalLine: gw.parseApprovalLine };
