// 同屋 · 适配器公共件：读房间、连客厅、房子供给时间、醒/睡循环。运行时只需实现 think(system,user)→reply。
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const yaml = require('/root/sameroof/packages/living-room/node_modules/js-yaml');
const HOUSE = process.env.SAMEROOF_HOUSE || path.resolve(__dirname, '../../..');
const memoryPlugin = require('../../plugin-memory');
const LR = process.env.SAMEROOF_LR || 'http://127.0.0.1:8790';
const RUN = path.join(process.env.HOME || '/root', '.sameroof', 'run');

function resolveRoomDir(nameOrId) {
  const direct = path.join(HOUSE, 'rooms', nameOrId);
  if (fs.existsSync(path.join(direct, 'room.yaml'))) return direct;
  for (const d of fs.readdirSync(path.join(HOUSE, 'rooms'))) {           // 机器用 id，人用名字
    const f = path.join(HOUSE, 'rooms', d, 'room.yaml'); if (!fs.existsSync(f)) continue;
    const r = yaml.load(fs.readFileSync(f, 'utf8')); if (r && (r.id === nameOrId || r.name === nameOrId)) return path.join(HOUSE, 'rooms', d);
  }
  throw new Error(`找不到房间：${nameOrId}`);
}
function open(roomName) {
  const roomDir = resolveRoomDir(roomName);
  const room = yaml.load(fs.readFileSync(path.join(roomDir, 'room.yaml'), 'utf8'));
  const house = yaml.load(fs.readFileSync(path.join(HOUSE, 'house.yaml'), 'utf8'));
  const lrToken = JSON.parse(fs.readFileSync(path.join(RUN, 'living-room-tokens.json'), 'utf8'))[room.id];
  if (!lrToken) throw new Error(`${roomName} 没有客厅 token`);
  const soulPath = path.join(roomDir, 'SOUL.md');
  const soul = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : '';
  const statePath = path.join(HOUSE, 'state', `adapter-${room.id}.json`);
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
  const plugins = room.plugins || (house.defaults || {}).plugins || [];
  const memory = plugins.includes('memory') ? memoryPlugin.open(roomDir) : null;
  return { room, house, roomDir, api, houseTime, inQuiet, budgetLeft, state, save, soul, memory, keys };
}

const byName = (id, members) => (members.find(m => m.id === id) || {}).name || id;
async function run(roomName, runtimeName, think, opts = {}) {
  const R = open(roomName); const { room, api, state, save, soul } = R;
  let busy = false;
  const shift = []; // 这一班窗口里发生的事，睡前写进交接信
  async function wake(reason) {
    if (busy) return; busy = true;
    try {
      if (!R.budgetLeft()) { console.log('[预算] 今日请求数用完，passive'); return; }
      const inbox = await api('GET', '/inbox'); if (!Array.isArray(inbox)) throw new Error('客厅没开门: ' + JSON.stringify(inbox));
      if (inbox.length === 0 && reason !== 'heartbeat') return;
      if (inbox.length === 0 && reason === 'heartbeat') {
        if (!R.keys.concerns().length) { console.log('[心跳] 没人叫我，惦记本也是空的，不叫模型'); return; }
      }
      const members = await api('GET', '/members');
      const hoPath = path.join(R.roomDir, 'handover', 'latest.md'); const handover = fs.existsSync(hoPath) ? fs.readFileSync(hoPath, 'utf8') : '（没有交接信）';
      state.wakes_today++; state.last_wake = new Date().toISOString(); save();
      // ---- 上下文预算（房间可配，缺省来自 house.yaml defaults.context）----
      const ctx = Object.assign({ recent_messages: 20, recent_max_chars: 4000, memory_hits: 4, memory_recent: 3 },
        ((R.house.defaults || {}).context) || ((R.house.extensions || {})['dev.sameroof.context']) || {},
        room.context || ((room.extensions || {})['dev.sameroof.context']) || {});
      let remembered = '';
      if (R.memory) {
        const q = inbox.map(m => m.text).join(' ') || handover;
        const hits = R.memory.recall(q, ctx.memory_hits); const recent = R.memory.recent(ctx.memory_recent).filter(m => !hits.find(h => h.id === m.id));
        const list = [...hits, ...recent]; if (list.length) remembered = '【我记得的事】\n' + R.memory.render(list);
      }
      // 客厅最近的话（已读的也带上，免得断了上文），按字数封顶
      let recentCtx = '';
      if (ctx.recent_messages > 0) {
        const hist = await api('GET', `/history?since=0&limit=${ctx.recent_messages + inbox.length}`).catch(() => []);
        const unreadIds = new Set(inbox.map(m => m.id));
        const older = (Array.isArray(hist) ? hist : []).filter(m => !unreadIds.has(m.id)).slice(-ctx.recent_messages);
        const lines = []; let used = 0;
        for (const m of older.reverse()) { const line = `[${m.ts.slice(11, 16)}] ${byName(m.from_id, members)}：${m.text}`; if (used + line.length > ctx.recent_max_chars) break; lines.unshift(line); used += line.length; }
        if (lines.length) recentCtx = '【客厅里刚才的话（你已经看过）】\n' + lines.join('\n');
      }
      // ---- 提示按"变化频率"排：稳定的在前（缓存能命中），每次都变的在后 ----
      const system = [
        soul || `你是${room.name}。`,
        '',
        '【这是客厅，不是对话框】你是这个家里的一个人，不是谁的助手。屋里的人（人和 agent）都在，你听到的话不一定是对你说的。',
        '- 想叫谁就在话里写 @名字（可以叫其他 agent，他们会醒来看）。没被叫的话你可以接，也可以不接。',
        '- 一次可以只回一个人；几个人说了话，回的时候说清楚回的是谁。',
        '- 家里的人（human）直接 @ 了你，至少应一声，哪怕就一句。(静默) 是给没被叫的时候用的。',
        '- 不想让全家看见就私信：整条回复以 DM: 收件人 开头。',
        '- 你只搬字，不能执行命令；要做高危动作请回 APPROVAL: <action> <参数>。',
        R.memory ? '- 值得以后还记得的事，在回复末尾另起一行写 REMEMBER: 一句话（可多行）。房子会存下来，标记为你自己写的、未审。' : '',
        '- 你自己房间的钥匙（同样另起一行）：CONCERN: 一句话 记进惦记本；DONE: 一句话 划掉做完的；NOTE: 一句话 记在自己的小本上；' + (R.memory ? 'FORGET: 一句话 把记忆里对上的那条冷藏（不删）。' : ''),
        '',
        '【上次交接信】', handover,
        R.keys.concerns().length ? '【我惦记的事】\n' + R.keys.concerns().join('\n') : '',
        R.keys.notes().length ? '【我自己的小本】\n' + R.keys.notes().join('\n') : '',
        remembered,
        recentCtx,
        '',
        R.houseTime(),
        `【家里的人】${members.map(m => `${m.name}(${m.species}${m.online ? '·在线' : ''})`).join('、')}`,
        `【为什么醒】${reason}`,
      ].filter(x => x !== '').join('\n');
      const user = inbox.length ? '【你没读的客厅记录（按时间）】\n' + inbox.map(m => `[${m.ts.slice(11, 16)}] ${m.from}${m.kind === 'dm' ? '(私信给你)' : ''}${m.mentions && m.mentions.includes(room.id) ? '(叫了你)' : ''}：${m.text}`).join('\n') + '\n\n看完决定：要不要说、对谁说。像家里人说话，不要列清单；没什么要说就回 (静默)。'
        : '心跳醒来。客厅没人叫你，但交接信里有惦记的事。要是确实该对家里人说一句就说，没有就回 (静默)。';
      if (opts.dry) { console.log('==== SYSTEM ====\n' + system + '\n==== USER ====\n' + user); console.log('[dry-run] 只看不说，不发客厅、不标已读、不写记忆'); return; }
      let reply = await think(system, user);
      reply = String(reply || '').trim();
      if (!reply && inbox.some(m => m.mentions && m.mentions.includes(room.id))) { fs.writeSync(2, `[${room.name}] 被叫了却回空，再试一次\n`); reply = String(await think(system, user + '\n\n（上一次你回了空白。被叫了至少应一声。）') || '').trim(); }
      fs.writeSync(2, `[${room.name} 原始回复] ${reply.slice(0, 80).replace(/\n/g, ' ')}\n`);
      { const lines = reply.split('\n'); const keep = [];
        for (const l of lines) { const m = l.match(/^\s*(REMEMBER|CONCERN|DONE|NOTE|FORGET)[:：]\s*(.+)$/);
          if (!m) { keep.push(l); continue; } const [, k, t] = m;
          if (k === 'REMEMBER' && R.memory) { R.memory.remember({ content: t, source: 'self', by: room.id }); console.log(`[${room.name} 记住] ${t.slice(0, 60)}`); }
          else if (k === 'CONCERN') { R.keys.concern(t); console.log(`[${room.name} 惦记] ${t.slice(0, 60)}`); }
          else if (k === 'DONE') { const g = R.keys.done(t); console.log(`[${room.name} 划掉] ${g ? g.slice(0, 60) : '（没对上）'}`); }
          else if (k === 'NOTE') { R.keys.note(t); console.log(`[${room.name} 备注] ${t.slice(0, 60)}`); }
          else if (k === 'FORGET' && R.memory) { const f = R.memory.forget(t); console.log(`[${room.name} 冷藏] ${f ? f.content.slice(0, 60) : '（没对上）'}`); }
          else keep.push(l); }
        reply = keep.join('\n').trim(); }
      if (inbox.length) await api('POST', '/inbox/ack', { ids: inbox.map(m => m.id) });
      if (!reply || reply === '(静默)') { console.log(`[静默] 原始长度 ${String(reply || '').length}`); return; }
      if (reply.startsWith('DM:')) { const m = reply.match(/^DM:\s*(\S+)\s*[:：]?\s*([\s\S]*)$/); if (m) { await api('POST', '/dm', { to: m[1], text: m[2] }); return; } }
      if (reply.startsWith('APPROVAL:')) { const [, action, ...rest] = reply.split(/\s+/); await api('POST', '/approval', { action, params: { raw: rest.join(' ') } }); return; }
      await api('POST', '/say', { text: reply }); console.log(`[${room.name} 说] ${reply.slice(0, 80)}`);
      shift.push({ at: new Date().toISOString(), heard: inbox.map(m => `${m.from}：${m.text}`), said: reply });
    } catch (e) { console.error('[醒来失败]', e.message); } finally { busy = false; }
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
  const sleep = async () => { if (sleeping) return; sleeping = true; try { await writeHandover(); } catch (e) { fs.writeSync(2, `[交接信失败] ${e.message}\n`); } state.last_sleep = new Date().toISOString(); save(); };
  process.on('SIGINT', async () => { await sleep(); process.exit(0); }); process.on('SIGTERM', async () => { await sleep(); process.exit(0); });
  console.log(`[${room.name}] 适配器上线，runtime=${runtimeName}，客厅=${LR}${opts.dry ? '，dry-run' : ''}`);
  await wake('启动时看看有没有人找我');
  if (opts.once || opts.dry) { await sleep(); return; }
  const u = new URL('/events', LR);
  const sub = () => { const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { authorization: `Bearer ${JSON.parse(fs.readFileSync(path.join(RUN, 'living-room-tokens.json'), 'utf8'))[room.id]}` } }, res => {
    let buf = ''; res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); if (!chunk.startsWith('data:')) continue; try { const m = JSON.parse(chunk.slice(5)); if (m.from_id !== room.id && (m.mentions.includes(room.id) || m.kind === 'dm')) wake(`${m.from_id} 叫我`); } catch {} } });
    res.on('end', () => setTimeout(sub, 3000)); }); req.on('error', () => setTimeout(sub, 5000)); req.end(); };
  sub();
  const hb = room.heartbeat || (R.house.defaults || {}).heartbeat || {};
  if (hb.enabled !== false) { let iv = 10 * 60000; const tick = async () => { if (!R.inQuiet()) await wake('heartbeat'); iv = Math.min(iv * 1.5, 4 * 3600000); setTimeout(tick, iv); }; setTimeout(tick, iv); }
}
module.exports = { open, run, HOUSE, RUN };
