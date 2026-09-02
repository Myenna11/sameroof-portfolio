// 同屋 · 适配器公共件：读房间、连客厅、房子供给时间、醒/睡循环。运行时只需实现 think(system,user)→reply。
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const yaml = require('/root/sameroof/packages/living-room/node_modules/js-yaml');
const HOUSE = process.env.SAMEROOF_HOUSE || path.resolve(__dirname, '../../..');
const LR = process.env.SAMEROOF_LR || 'http://127.0.0.1:8790';
const RUN = path.join(process.env.HOME || '/root', '.sameroof', 'run');

function open(roomName) {
  const roomDir = path.join(HOUSE, 'rooms', roomName);
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
    const day = new Date().toISOString().slice(0, 10); if (state.day !== day) { state.day = day; state.wakes_today = 0; save(); }
    const cap = (((room.heartbeat || {}).budget || {}).per_day) || ((((house.defaults || {}).heartbeat || {}).budget || {}).per_day) || {};
    return !cap.requests || state.wakes_today < cap.requests;
  };
  return { room, house, roomDir, api, houseTime, inQuiet, budgetLeft, state, save, soul };
}

async function run(roomName, runtimeName, think, opts = {}) {
  const R = open(roomName); const { room, api, state, save, soul } = R;
  let busy = false;
  async function wake(reason) {
    if (busy) return; busy = true;
    try {
      if (!R.budgetLeft()) { console.log('[预算] 今日请求数用完，passive'); return; }
      const inbox = await api('GET', '/inbox'); if (!Array.isArray(inbox)) throw new Error('客厅没开门: ' + JSON.stringify(inbox));
      if (inbox.length === 0 && reason !== 'heartbeat') return;
      const members = await api('GET', '/members');
      const hoPath = path.join(R.roomDir, 'handover', 'latest.md'); const handover = fs.existsSync(hoPath) ? fs.readFileSync(hoPath, 'utf8') : '（没有交接信）';
      state.wakes_today++; state.last_wake = new Date().toISOString(); save();
      const system = [soul || `你是${room.name}。`, '', R.houseTime(), `【家里的人】${members.map(m => `${m.name}(${m.species}${m.online ? '·在线' : ''})`).join('、')}`,
        '【规矩】你在客厅里说话，全家都看得见；私信请以 DM: 开头并写收件人。你只搬字，不能执行命令；要做高危动作请回 APPROVAL: <action> <参数>。',
        `【为什么醒】${reason}`, '【上次交接信】', handover].join('\n');
      const user = inbox.length ? '【客厅里等你的话】\n' + inbox.map(m => `${m.from}${m.kind === 'dm' ? '(私信)' : ''}：${m.text}`).join('\n') + '\n\n回一句就好，像家里人说话，不要列清单。'
        : '心跳醒来。客厅没人叫你。读一下交接信，惦记一下没做完的事；确实有话要说就说一句，没有就回 (静默)。';
      let reply = opts.dry ? (console.log('==== SYSTEM ====\n' + system + '\n==== USER ====\n' + user), '(dry-run)') : await think(system, user);
      reply = String(reply || '').trim();
      if (inbox.length) await api('POST', '/inbox/ack', { ids: inbox.map(m => m.id) });
      if (!reply || reply === '(静默)') { console.log('[静默]'); return; }
      if (reply.startsWith('DM:')) { const m = reply.match(/^DM:\s*(\S+)\s*[:：]?\s*([\s\S]*)$/); if (m) { await api('POST', '/dm', { to: m[1], text: m[2] }); return; } }
      if (reply.startsWith('APPROVAL:')) { const [, action, ...rest] = reply.split(/\s+/); await api('POST', '/approval', { action, params: { raw: rest.join(' ') } }); return; }
      await api('POST', '/say', { text: reply }); console.log(`[${room.name} 说] ${reply.slice(0, 80)}`);
    } catch (e) { console.error('[醒来失败]', e.message); } finally { busy = false; }
  }
  const sleep = () => { state.last_sleep = new Date().toISOString(); save(); };
  process.on('SIGINT', () => { sleep(); process.exit(0); }); process.on('SIGTERM', () => { sleep(); process.exit(0); });
  console.log(`[${room.name}] 适配器上线，runtime=${runtimeName}，客厅=${LR}${opts.dry ? '，dry-run' : ''}`);
  await wake('启动时看看有没有人找我');
  if (opts.once || opts.dry) { sleep(); return; }
  const u = new URL('/events', LR);
  const sub = () => { const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { authorization: `Bearer ${JSON.parse(fs.readFileSync(path.join(RUN, 'living-room-tokens.json'), 'utf8'))[room.id]}` } }, res => {
    let buf = ''; res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); if (!chunk.startsWith('data:')) continue; try { const m = JSON.parse(chunk.slice(5)); if (m.from_id !== room.id && (m.mentions.includes(room.id) || m.kind === 'dm')) wake(`${m.from_id} 叫我`); } catch {} } });
    res.on('end', () => setTimeout(sub, 3000)); }); req.on('error', () => setTimeout(sub, 5000)); req.end(); };
  sub();
  const hb = room.heartbeat || (R.house.defaults || {}).heartbeat || {};
  if (hb.enabled !== false) { let iv = 10 * 60000; const tick = async () => { if (!R.inQuiet()) await wake('heartbeat'); iv = Math.min(iv * 1.5, 4 * 3600000); setTimeout(tick, iv); }; setTimeout(tick, iv); }
}
module.exports = { open, run, HOUSE, RUN };
