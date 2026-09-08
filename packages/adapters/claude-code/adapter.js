#!/usr/bin/env node
// 同屋 · 适配器 · claude-code：runtime_managed——凭证由 Claude Code 自己保管，房子只喂话、收话。
// V2-W8：一班内用 --resume 接同一个 session。首轮 --session-id 建会话；后续轮 --resume 接上。
// 队列/车道/看门狗/例行/黑板全在 room.js。
'use strict';
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const { open, run, HOUSE } = require('../lib/room');
const ROOM = process.argv[2] || '规划员';
const R = open(ROOM);

// ---- 会话状态：一班一个 session_id，落盘在 state/shift-<id>.json ----
const shiftStatePath = path.join(HOUSE, 'state', `cc-session-${R.room.id}.json`);
let sessionId = null;
let turnCount = 0;
try {
  if (fs.existsSync(shiftStatePath)) {
    const saved = JSON.parse(fs.readFileSync(shiftStatePath, 'utf8'));
    if (saved.session_id) { sessionId = saved.session_id; turnCount = saved.turns || 0; fs.writeSync(2, `[cc] 恢复 session ${sessionId}，已有 ${turnCount} 轮\n`); }
  }
} catch (e) { fs.writeSync(2, `[cc] 恢复 session 失败：${e.message}\n`); }

function saveSession() {
  try { fs.writeFileSync(shiftStatePath, JSON.stringify({ session_id: sessionId, turns: turnCount, updated: new Date().toISOString() })); }
  catch (e) { fs.writeSync(2, `[cc] 保存 session 失败：${e.message}\n`); }
}

function think(system, user, signal) {
  return new Promise((resolve, reject) => {
    const isFirst = !sessionId;
    if (isFirst) sessionId = randomUUID();

    const args = ['-p', '--output-format', 'json', '--max-turns', '1', '--allowedTools', ''];
    if (isFirst) {
      // 首轮：建新会话，传 system prompt
      args.push('--session-id', sessionId, '--append-system-prompt', system);
    } else {
      // 续轮：--resume 接上，不再传 system（已在 session 里）
      args.push('--resume', sessionId);
    }

    const p = spawn('claude', args, { cwd: R.roomDir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', e => { if (isFirst) sessionId = null; reject(e); });
    p.on('close', c => {
      if (c !== 0) {
        // --resume 失败（session 过期/不存在）→ 回退到新 session 重试
        if (!isFirst && /session|not found|expired/i.test(err + out)) {
          fs.writeSync(2, `[cc] --resume 失败，回退到新 session\n`);
          sessionId = null; turnCount = 0;
          try { fs.unlinkSync(shiftStatePath); } catch {}
          think(system, user, signal).then(resolve, reject);
          return;
        }
        if (isFirst) sessionId = null;
        return reject(new Error((err || out || `claude exit ${c}`).slice(0, 300)));
      }
      // 解析 JSON 输出，提取文本
      let text = out;
      try {
        const j = JSON.parse(out);
        // claude -p --output-format json 返回 { type, subtype, session_id, result, ... }
        if (j.result) text = j.result;
        else if (j.content) text = typeof j.content === 'string' ? j.content : JSON.stringify(j.content);
      } catch {
        // 不是 JSON（可能 claude 版本不支持）→ 当纯文本用
      }
      turnCount++;
      saveSession();
      resolve(text);
    });
    if (signal) signal.addEventListener('abort', () => { try { p.kill('SIGKILL'); } catch {} reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || 'aborted'))); }, { once: true });
    p.stdin.on('error', () => {});
    p.stdin.write(user); p.stdin.end();
  });
}

// room.js 的 sleep() 会调 think.shift.archive()——给它一个 shift 接口
think.shift = {
  messages: [],   // claude-code 自己管 messages，这里只给 room.js 看
  archive() {
    sessionId = null; turnCount = 0;
    try { fs.unlinkSync(shiftStatePath); } catch {}
    fs.writeSync(2, `[cc] session 归档（清掉）\n`);
  },
  turns() { return turnCount; },
};

run(R.room.name, 'claude-code', think, { dry: process.argv.includes('--dry'), once: process.argv.includes('--once') });
