#!/usr/bin/env node
// 同屋 · 适配器 · claude-code：runtime_managed——凭证由 Claude Code 自己保管，房子只喂话、收话。
// V2-W8：一班内用 --resume 接同一个 session。session 生命周期在 shift 层管。
// 队列/车道/看门狗/例行/黑板全在 room.js。
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const { open, run, HOUSE } = require('../lib/room');
const { createSessionShift } = require('../lib/shift-messages');
const ROOM = process.argv[2] || '规划员';
const R = open(ROOM);

const shift = createSessionShift(path.join(HOUSE, 'state', `cc-session-${R.room.id}.json`));

function think(system, user, signal) {
  return new Promise((resolve, reject) => {
    const wasFirst = shift.isFirst();
    const sid = shift.open();

    const args = ['-p', '--output-format', 'json', '--max-turns', '1', '--allowedTools', ''];
    if (wasFirst) args.push('--session-id', sid, '--append-system-prompt', system);
    else args.push('--resume', sid);

    const p = spawn('claude', args, { cwd: R.roomDir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', e => { shift.revert(wasFirst); reject(e); });
    p.on('close', c => {
      if (c !== 0) {
        if (!wasFirst && /session|not found|expired/i.test(err + out)) {
          shift.reset();
          think(system, user, signal).then(resolve, reject);
          return;
        }
        shift.revert(wasFirst);
        return reject(new Error((err || out || `claude exit ${c}`).slice(0, 300)));
      }
      let text = out;
      try { const j = JSON.parse(out); text = j.result || (typeof j.content === 'string' ? j.content : out); } catch {}
      shift.commit();
      resolve(text);
    });
    if (signal) signal.addEventListener('abort', () => { try { p.kill('SIGKILL'); } catch {} reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || 'aborted'))); }, { once: true });
    p.stdin.on('error', () => {});
    p.stdin.write(user); p.stdin.end();
  });
}
think.shift = shift;

run(R.room.name, 'claude-code', think, { dry: process.argv.includes('--dry'), once: process.argv.includes('--once') });
