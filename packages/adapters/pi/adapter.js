#!/usr/bin/env node
// 同屋 · 适配器 · pi：runtime_managed——凭证由 pi 自己保管（/login 走 OAuth），房子只喂话、收话。
// 用 pi -p 无头模式：SOUL 当系统提示，关掉全部工具（客厅只搬字），不存会话（记忆归房间不归 pi）。
'use strict';
const { spawn } = require('child_process');
const { open, run } = require('../lib/room');
const ROOM = process.argv[2] || '实现员';
const R = open(ROOM);
const model = `${R.room.model.provider}/${R.room.model.id}`;
function think(system, user) {
  return new Promise((resolve, reject) => {
    const p = spawn('pi', ['-p', '--model', model, '--system-prompt', system, '--no-tools', '--no-session', user], { cwd: R.roomDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: process.env.HOME || '/root' } });
    let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', c => c === 0 ? resolve(out) : reject(new Error((err || out || `pi exit ${c}`).slice(0, 300))));
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} reject(new Error('pi 超时 120s')); }, 120000);
  });
}
run(R.room.name, 'pi', think, { dry: process.argv.includes('--dry'), once: process.argv.includes('--once') });
