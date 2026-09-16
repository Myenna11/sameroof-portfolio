'use strict';
// 审查员 P1-2: mailbox items are consumed ONLY when the coordinator accepted the publication (2xx + expected shape).
// Real living-room; failures are real: DM to an unknown recipient (404), a >8000-char say (413), APPROVAL with no gateway.
const assert = require('node:assert/strict');
const fs = require('node:fs'); const http = require('node:http'); const os = require('node:os'); const path = require('node:path');
const test = require('node:test');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, label, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout: ' + label); await sleep(80); } };
const req = (port, p, o = {}) => new Promise((res, rej) => { const b = o.body ? Buffer.from(JSON.stringify(o.body)) : null; const r = http.request({ hostname: '127.0.0.1', port, path: p, method: o.method || 'GET', headers: { ...(o.token ? { authorization: 'Bearer ' + o.token } : {}), ...(b ? { 'content-type': 'application/json', 'content-length': b.length } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let v; try { v = JSON.parse(s); } catch { v = s; } res({ status: x.statusCode, body: v }); }); }); r.on('error', rej); if (b) r.write(b); r.end(); });

test('DM 404 / say 413 / approval rejected → not consumed, attempt marker, replayed; then a 200 say consumes', { timeout: 40000 }, async () => {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-mbc-')); const RUN_DIR = path.join(ROOT, '.sameroof', 'run');
  for (const d of ['rooms/甲', 'rooms/乙/state', 'apps/house', 'state']) fs.mkdirSync(path.join(ROOT, d), { recursive: true }); fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(ROOT, 'house.yaml'), 'schema_version: 1\nname: mbc\ntimezone: UTC\ndefaults:\n  runtime: broker-direct\n  plugins: [living-room]\n  heartbeat: {enabled: false}\n  context: {recent_messages: 5, recent_max_chars: 2000, memory_hits: 0, memory_recent: 0}\n  approve_timeout: 1m\n  permissions: {core.fs.read: approve}\n  subagent: {enabled: true}\ncredentials: []\nnotify: {admin: 甲}\n');
  fs.writeFileSync(path.join(ROOT, 'rooms', '甲', 'room.yaml'), 'schema_version: 1\nid: resident_alpha_01\nname: 甲\nspecies: human\n');
  fs.writeFileSync(path.join(ROOT, 'rooms', '乙', 'room.yaml'), 'schema_version: 1\nid: resident_beta_01\nname: 乙\nspecies: agent\nplugins: [living-room]\nheartbeat: {enabled: false}\n');
  fs.writeFileSync(path.join(ROOT, 'apps', 'house', 'index.html'), '<!doctype html>');
  // pre-seed a subresult (manager absent → no callOnce; mailbox still exists because subagent.enabled)
  fs.writeFileSync(path.join(ROOT, 'rooms', '乙', 'state', 'mailbox.jsonl'), JSON.stringify({ id: 'mb_seed1', ts: new Date().toISOString(), consumed: false, attempts: [], kind: 'subresult', sub_id: 'sub_seed1', status: 'ok', summary: 'SEEDED RESULT', task: 't' }) + '\n');
  const saved = {}; for (const k of ['HOME', 'SAMEROOF_ROOT', 'SAMEROOF_LR']) saved[k] = process.env[k];
  process.env.HOME = ROOT; process.env.SAMEROOF_ROOT = ROOT; delete process.env.SAMEROOF_LR;
  for (const m of ['../lib/room', '../lib/gateway-client', '../lib/subrun-manager', '../lib/subagent']) delete require.cache[require.resolve(m)];
  const { createLivingRoom } = require('@sameroof/living-room/server'); const { run } = require('../lib/room');
  const mail = () => fs.readFileSync(path.join(ROOT, 'rooms', '乙', 'state', 'mailbox.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)[0];
  let room, ctrl = new AbortController(), adapterP;
  try {
    room = createLivingRoom({ houseDir: ROOT, runDir: RUN_DIR, dataDir: path.join(ROOT, 'state'), port: 0, approvalLimit: 50 });
    const port = (await room.listen()).port;
    fs.writeFileSync(path.join(RUN_DIR, 'living-room-tokens.json'), JSON.stringify({ resident_beta_01: room.tokenStore.issue('resident_beta_01').token }));
    const human = room.tokenStore.issue('resident_alpha_01').token;
    const script = ['DM: 不存在的人 你好', 'x'.repeat(9000), 'APPROVAL: core.fs.read {"root_id":"own-room","path":"a.txt"}', '最后这次说出去'];
    let step = 0; const seen = [];
    const think = async (system, user) => { seen.push(user); if (!/【子任务结果】/.test(user)) return '(静默)'; return script[Math.min(step++, script.length - 1)]; };
    adapterP = run('乙', 'broker-direct', think, { signal: ctrl.signal, lr: 'http://127.0.0.1:' + port });   // no callOnce → manager null, mailbox present
    // wake 1 (startup): mailbox item counts as "called me" → DM to unknown → 404 → not consumed
    await until(() => mail().attempts.length >= 1, 'attempt 1');
    let m = mail(); assert.equal(m.consumed, false); assert.equal(m.attempts[0].exit, 'dm_failed');
    // wake 2: say 9000 chars → 413 → not consumed, second attempt
    await req(port, '/say', { method: 'POST', token: human, body: { text: '@乙 继续' } });
    await until(() => mail().attempts.length >= 2, 'attempt 2');
    m = mail(); assert.equal(m.consumed, false); assert.equal(m.attempts[1].exit, 'say_failed');
    assert.ok(seen.some(u => /上一轮已尝试处理：dm_failed/.test(u)), 'replay carried the marker');
    // wake 3: APPROVAL with no gateway → gateway_unavailable (error path) → not consumed
    await req(port, '/say', { method: 'POST', token: human, body: { text: '@乙 再来' } });
    await until(() => mail().attempts.length >= 3, 'attempt 3');
    m = mail(); assert.equal(m.consumed, false); assert.match(m.attempts[2].exit, /gateway_unavailable|approval_invalid|error/);
    // wake 4: a real say → 200 → consumed
    await req(port, '/say', { method: 'POST', token: human, body: { text: '@乙 最后' } });
    await until(() => mail().consumed === true, 'consumed');
    m = mail(); assert.equal(m.attempts[m.attempts.length - 1].exit, 'say');
    assert.ok(((await req(port, '/history?limit=10', { token: human })).body || []).some(x => x.from_id === 'resident_beta_01' && /最后这次说出去/.test(x.text)));
  } finally {
    ctrl.abort(); if (adapterP) await Promise.race([adapterP, sleep(6000)]); if (room) await room.close().catch(() => {});
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
});
