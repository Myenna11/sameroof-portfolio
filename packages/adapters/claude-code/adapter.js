#!/usr/bin/env node
// 同屋 · 适配器 · claude-code：runtime_managed——凭证由 Claude Code 自己保管，房子只喂话、收话。
// 用 claude -p 无头模式：SOUL 走 --append-system-prompt，单轮、关掉全部工具（客厅只搬字）。队列/车道/看门狗/例行/黑板全在 room.js。
'use strict';
const { spawn } = require('child_process');
const { open, run } = require('../lib/room');
const ROOM = process.argv[2] || '规划员';
const R = open(ROOM);
function think(system, user, signal) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'text', '--append-system-prompt', system, '--max-turns', '1', '--allowedTools', ''];
    const p = spawn('claude', args, { cwd: R.roomDir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
    let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('error', reject);
    p.on('close', c => c === 0 ? resolve(out) : reject(new Error((err || out || `claude exit ${c}`).slice(0, 300))));
    if (signal) signal.addEventListener('abort', () => { try { p.kill('SIGKILL'); } catch {} reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || 'aborted'))); }, { once: true });
    p.stdin.on('error', () => {});                                          // 子进程先死了再写 stdin 会 EPIPE，close 那边已经 reject 了
    p.stdin.write(user); p.stdin.end();
  });
}
run(R.room.name, 'claude-code', think, { dry: process.argv.includes('--dry'), once: process.argv.includes('--once') });
