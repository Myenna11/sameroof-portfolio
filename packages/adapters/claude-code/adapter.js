#!/usr/bin/env node
// 同屋 · 房间适配器 · claude-code
// 职责：SOUL→系统提示；时间由房子供给；inbox→上下文；输出→客厅。不持有任何凭证（Claude Code 自管，runtime_managed）。
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), { spawn } = require('child_process');
const yaml = require('js-yaml');
const { resolveHouseRoot } = require('@sameroof/house-root');

const HOUSE = resolveHouseRoot();
const ROOM = process.argv[2] || '规划员';
const DRY = process.argv.includes('--dry');
const LR = process.env.SAMEROOF_LR || 'http://127.0.0.1:8790';
const roomDir = path.join(HOUSE, 'rooms', ROOM);
const room = yaml.load(fs.readFileSync(path.join(roomDir, 'room.yaml'), 'utf8'));
const house = yaml.load(fs.readFileSync(path.join(HOUSE, 'house.yaml'), 'utf8'));
const tokens = JSON.parse(fs.readFileSync(path.join(process.env.HOME || '/root', '.sameroof/run/living-room-tokens.json'), 'utf8'));
const TOKEN = tokens[room.id]; if (!TOKEN) throw new Error(`${ROOM} 没有客厅 token`);
const soulPath = path.join(roomDir, 'SOUL.md');
const soul = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : '';
const statePath = path.join(HOUSE, 'state', `adapter-${room.id}.json`);
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { last_sleep: null, last_wake: null, wakes_today: 0, day: null };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

// ---------- 客厅 ----------
function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, LR);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } }, res => {
      let s = ''; res.on('data', c => s += c); res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(s); } });
    });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}

// ---------- 时间由房子供给 ----------
function houseTime() {
  const tz = (room.schedule && room.schedule.timezone && room.schedule.timezone !== 'inherit') ? room.schedule.timezone : house.timezone;
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(now);
  const sleptFor = state.last_sleep ? Math.round((now - new Date(state.last_sleep)) / 60000) : null;
  return `【房子供给的时间】现在是 ${fmt}（${tz}）。` + (state.last_sleep ? `你上次睡是 ${state.last_sleep}，睡了约 ${sleptFor} 分钟。` : '这是你在这间屋子里第一次醒来。') + ` 今天你已醒来 ${state.wakes_today} 次。`;
}
function inQuiet() {
  const q = (room.heartbeat && room.heartbeat.quiet_hours) || (room.schedule && room.schedule.quiet_hours) || (house.schedule && house.schedule.quiet_hours);
  if (!q) return false;
  const tz = house.timezone;
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date()));
  const [a, b] = q.split('-').map(s => Number(s.split(':')[0]));
  return a <= b ? (h >= a && h < b) : (h >= a || h < b);
}
function budgetLeft() {
  const day = new Date().toISOString().slice(0, 10);
  if (state.day !== day) { state.day = day; state.wakes_today = 0; save(); }
  const cap = ((room.heartbeat || {}).budget || {}).per_day || ((house.defaults || {}).heartbeat || {}).budget.per_day || {};
  return !cap.requests || state.wakes_today < cap.requests;
}

// ---------- 醒来 ----------
let busy = false;
async function wake(reason) {
  if (busy) return; busy = true;
  try {
    if (!budgetLeft()) { console.log('[预算] 今日请求数用完，passive'); return; }
    const inbox = await api('GET', '/inbox');
    if (!Array.isArray(inbox) || (inbox.length === 0 && reason !== 'heartbeat')) return;
    const members = await api('GET', '/members');
    const handover = fs.existsSync(path.join(roomDir, 'handover', 'latest.md')) ? fs.readFileSync(path.join(roomDir, 'handover', 'latest.md'), 'utf8') : '（没有交接信）';
    state.wakes_today++; state.last_wake = new Date().toISOString(); save();

    const system = [
      soul || `你是${room.name}。`,
      '',
      houseTime(),
      `【家里的人】${members.map(m => `${m.name}(${m.species}${m.online ? '·在线' : ''})`).join('、')}`,
      '【规矩】你在客厅里说话，全家都看得见；私信请以 DM: 开头并写收件人。你只搬字，不能执行命令；要做高危动作请回 APPROVAL: <action> <参数>。',
      `【为什么醒】${reason}`,
      '【上次交接信】', handover,
    ].join('\n');
    const user = inbox.length
      ? '【客厅里等你的话】\n' + inbox.map(m => `${m.from}${m.kind === 'dm' ? '(私信)' : ''}：${m.text}`).join('\n') + '\n\n回一句就好，像家里人说话，不要列清单。'
      : '心跳醒来。客厅没人叫你。读一下交接信，惦记一下没做完的事；如果确实有话要对家里人说就说一句，没有就回 (静默)。';

    let reply;
    if (DRY) { console.log('==== SYSTEM ====\n' + system + '\n==== USER ====\n' + user); reply = '(dry-run，没有真的叫醒模型)'; }
    else reply = await runClaude(system, user);
    reply = String(reply || '').trim();
    if (inbox.length) await api('POST', '/inbox/ack', { ids: inbox.map(m => m.id) });
    if (!reply || reply === '(静默)') { console.log('[静默]'); return; }
    if (reply.startsWith('DM:')) { const m = reply.match(/^DM:\s*(\S+)\s*[:：]?\s*([\s\S]*)$/); if (m) return void await api('POST', '/dm', { to: m[1], text: m[2] }); }
    if (reply.startsWith('APPROVAL:')) { const [, action, ...rest] = reply.split(/\s+/); await api('POST', '/approval', { action, params: { raw: rest.join(' ') } }); return; }
    await api('POST', '/say', { text: reply });
    console.log(`[说] ${reply.slice(0, 80)}`);
  } catch (e) { console.error('[醒来失败]', e.message); }
  finally { busy = false; }
}
function runClaude(system, user) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'text', '--append-system-prompt', system, '--max-turns', '1', '--allowedTools', ''];
    const p = spawn('claude', args, { cwd: roomDir, env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
    let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', c => c === 0 ? resolve(out) : reject(new Error(err || `claude exit ${c}`)));
    p.stdin.write(user); p.stdin.end();
  });
}

// ---------- 睡 ----------
function sleep() { state.last_sleep = new Date().toISOString(); save(); }
process.on('SIGINT', () => { sleep(); process.exit(0); }); process.on('SIGTERM', () => { sleep(); process.exit(0); });

// ---------- 主循环：订阅客厅 + 心跳 ----------
async function main() {
  console.log(`[${room.name}] 适配器上线，runtime=claude-code (${(room.model && room.model.auth && room.model.auth.mode) || '?'})，客厅=${LR}${DRY ? '，dry-run' : ''}`);
  await wake('启动时看看有没有人找我');
  if (DRY) return;
  const u = new URL('/events', LR);
  const sub = () => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { authorization: `Bearer ${TOKEN}` } }, res => {
      let buf = ''; res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); if (!chunk.startsWith('data:')) continue; try { const m = JSON.parse(chunk.slice(5)); if (m.from_id !== room.id && (m.mentions.includes(room.id) || m.kind === 'dm')) wake(`${m.from_id} 叫我`); } catch {} } });
      res.on('end', () => setTimeout(sub, 3000));
    }); req.on('error', () => setTimeout(sub, 5000)); req.end();
  };
  sub();
  const hb = room.heartbeat || house.defaults.heartbeat || {};
  if (hb.enabled !== false) {
    let interval = 10 * 60 * 1000;
    const tick = async () => { if (!inQuiet()) await wake('heartbeat'); interval = Math.min(interval * 1.5, 4 * 3600 * 1000); setTimeout(tick, interval); };
    setTimeout(tick, interval);
  }
}
main();
