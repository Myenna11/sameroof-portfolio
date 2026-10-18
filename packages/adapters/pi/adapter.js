#!/usr/bin/env node
// 同屋 · 适配器 · pi：runtime_managed——凭证由 pi 自己保管（/login 走 OAuth），房子只喂话、收话。
// 一班之内用同一个 pi 会话接着聊（--session-dir + --continue），住户是真在对话里，不是每句都重读一遍记录；
// 隔太久没说话或这一班聊太多就归档换新会话。关掉全部工具（客厅只搬字）。交接信这类一次性调用不进会话。
'use strict';
const ROOM = process.argv[2];
if (!ROOM) { console.error('usage: node adapter.js <room-name>   (sameroof serve passes this for you)'); process.exit(2); }
const fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const { open, run, HOUSE } = require('../lib/room');
const R = open(ROOM);
const model = `${R.room.model.provider}/${R.room.model.id}`;
const SHIFT_DIR = process.env.SAMEROOF_PI_SHIFT_DIR || path.join(HOUSE, 'state', `pi-shift-${R.room.id}`);
const ARCHIVE_DIR = path.join(path.dirname(SHIFT_DIR), 'shifts');
const META = path.join(SHIFT_DIR, 'shift.json');
const IDLE_MS = (Number((R.room.model || {}).shift_idle_hours) || 3) * 3600e3;
const MAX_TURNS = Number((R.room.model || {}).shift_max_turns) || 40;

const readMeta = () => { try { return JSON.parse(fs.readFileSync(META, 'utf8')); } catch { return { turns: 0, last: 0 }; } };
const hasSession = () => { try { return fs.readdirSync(SHIFT_DIR).some(f => f !== 'shift.json'); } catch { return false; } };
function archive() {
  if (!fs.existsSync(SHIFT_DIR)) return;
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  fs.renameSync(SHIFT_DIR, path.join(ARCHIVE_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-pi-${R.room.id}`));
}
// 房子在拼上下文前先问 turns()：这时候顺手检查要不要换班。换了就是 0，房子会重新给全量上下文和交接信
function turns() {
  const m = readMeta();
  if ((m.turns || 0) > 0 && (!hasSession() || Date.now() - (m.last || 0) > IDLE_MS || m.turns >= MAX_TURNS)) { archive(); return 0; }
  return m.turns || 0;
}

function think(system, user, signal, opts = {}) {
  const oneShot = !!opts.oneShot;
  let cont = false, meta = null;
  if (!oneShot) { meta = readMeta(); cont = (meta.turns || 0) > 0 && hasSession(); fs.mkdirSync(SHIFT_DIR, { recursive: true }); }
  const session = oneShot ? ['--no-session'] : ['--session-dir', SHIFT_DIR, ...(cont ? ['--continue'] : [])];
  return new Promise((resolve, reject) => {
    const p = spawn('pi', ['-p', '--model', model, '--system-prompt', system, '--no-tools', ...session, user], { cwd: R.roomDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: process.env.HOME || '/root' } });
    let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', c => {
      if (c !== 0) return reject(new Error((err || out || `pi exit ${c}`).slice(0, 300)));
      if (!oneShot) fs.writeFileSync(META, JSON.stringify({ turns: (cont ? meta.turns || 0 : 0) + 1, last: Date.now(), started: cont ? meta.started : new Date().toISOString() }));
      resolve(out);
    });
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} reject(new Error('pi 超时 120s')); }, 120000);
    p.on('close', () => clearTimeout(t));
    if (signal) signal.addEventListener('abort', () => { try { p.kill('SIGKILL'); } catch {} reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || 'aborted'))); }, { once: true });
  });
}
think.shift = { turns, archive };

module.exports = { think, SHIFT_DIR };
if (require.main === module) run(R.room.name, 'pi', think, { dry: process.argv.includes('--dry'), once: process.argv.includes('--once') });
