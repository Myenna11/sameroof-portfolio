'use strict';
// Test launcher for a REAL adapter process (test/subagent-lifecycle.test.js). Same production shape as broker-direct/adapter.js
// — run() with NO signal, SIGINT/SIGTERM handled by room.js's shutdown() — but the model is scripted so no broker is needed.
// Env: ROOM, SAMEROOF_LR, SUB_DELAY_MS (callOnce sleeps this long before its 2nd reply), plus the usual SAMEROOF_ROOT/HOME/gateway vars.
const { run } = require('../lib/room');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const delay = Number(process.env.SUB_DELAY_MS || 0);
const seen = [];
const think = async (system, user, signal) => {
  if (process.env.HANG_HANDOVER === '1' && /现在要睡了/.test(system)) { process.stdout.write('HANDOVER_THINK_HANG\n'); return new Promise((_, rej) => { if (signal) signal.addEventListener('abort', () => rej(signal.reason), { once: true }); }); }   // never resolves unless abandoned
  seen.push(user); process.stdout.write('PROMPT ' + JSON.stringify(user.slice(0, 4000)) + '\n');
  const inboxPart = user.split('【你没读的客厅记录')[1] || '';   // triggers only on NEW inbox lines, never on recent context (else a restart re-triggers SUB:)
  const parts = [];
  if (/【子任务结果】/.test(user)) parts.push(user.includes('interrupted') ? '子任务被中断了，我重新看。' : '找到了：' + (user.match(/(src\/[ab]\.js[^\n]*)/g) || []).join('; '));
  if (/网关结果/.test(inboxPart)) parts.push('看到一条网关结果。');
  if (/找出所有调 recall/.test(inboxPart)) parts.push('收到，我去查。\nSUB: 找出 src/ 下所有调用 recall() 的位置 | 带上: 用 grep -rn "recall(" src/ | 工具: core.exec.ro');
  return parts.length ? parts.join('\n') : '(静默)';
};
let n = 0;
const callOnce = async (messages, signal) => {
  n++;
  const last = messages[messages.length - 1].content;
  if (/【工具结果】/.test(last)) { if (delay) await new Promise((res, rej) => { const t = setTimeout(res, delay); signal && signal.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason); }, { once: true }); }); return { text: 'callers: ' + (last.match(/src\/[ab]\.js:\d+:[^\n]*/g) || []).join('; '), usage: {} }; }
  return { text: 'TOOL: core.exec.ro {"argv":["/bin/sh","-lc","grep -rn \\"recall(\\" src/"],"cwd":{"root_id":"code","path":""},"timeout_ms":10000}', usage: {} };
};
// Production shape: run() resolves right after setup when no signal is given; the process stays alive on SSE/timers and exits via room.js's SIGINT/SIGTERM shutdown().
run(process.env.ROOM, 'broker-direct', think, { lr: process.env.SAMEROOF_LR, callOnce }).catch(e => { console.error(e); process.exit(1); });
