'use strict';
// Subagent V0 end-to-end (design v5 §6 exit criteria 1, 3, 7, 9): REAL coordinator, REAL gateway with bwrap, lib/room.js run(),
// scripted model. A human asks "find every caller of X"; the parent emits SUB:; the subrun greps under core.exec.ro with NO human
// click; the summary comes back through the local mailbox; the parent re-wakes and answers. The gateway's result DM for the subrun's
// intent must NOT wake/interrupt the parent (contract B); a human message during the subrun still gets answered.
const assert = require('node:assert/strict');
const fs = require('node:fs'); const http = require('node:http'); const os = require('node:os'); const path = require('node:path');
const test = require('node:test');

const sandboxOk = () => { try { const { spawnSync } = require('node:child_process'); return spawnSync('/usr/bin/bwrap', ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', '/bin/true'], { stdio: 'ignore', timeout: 5000 }).status === 0; } catch { return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, label, ms = 20000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout: ' + label); await sleep(100); } };
const req = (port, p, o = {}) => new Promise((res, rej) => { const b = o.body ? Buffer.from(JSON.stringify(o.body)) : null; const r = http.request({ hostname: '127.0.0.1', port, path: p, method: o.method || 'GET', headers: { ...(o.token ? { authorization: 'Bearer ' + o.token } : {}), ...(b ? { 'content-type': 'application/json', 'content-length': b.length } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let v; try { v = JSON.parse(s); } catch { v = s; } res({ status: x.statusCode, body: v }); }); }); r.on('error', rej); if (b) r.write(b); r.end(); });

test('SUB: → subrun greps via core.exec.ro (no click) → mailbox → parent re-wakes with the answer; result DM filtered; human not blocked', { skip: !sandboxOk() && 'bwrap unavailable', timeout: 60000 }, async () => {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-sube2e-')); const RUN_DIR = path.join(ROOT, '.sameroof', 'run');
  for (const d of ['rooms/甲', 'rooms/乙/state', 'apps/house', 'state', 'src']) fs.mkdirSync(path.join(ROOT, d), { recursive: true }); fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(ROOT, 'src', 'a.js'), 'x();\nrecall(1);\n'); fs.writeFileSync(path.join(ROOT, 'src', 'b.js'), 'await recall(2);\n'); fs.writeFileSync(path.join(ROOT, 'src', 'c.js'), 'nothing\n');
  fs.writeFileSync(path.join(ROOT, 'house.yaml'), `schema_version: 1
name: sub-e2e
timezone: UTC
defaults:
  runtime: broker-direct
  plugins: [living-room]
  heartbeat: {enabled: false}
  context: {recent_messages: 20, recent_max_chars: 4000, memory_hits: 0, memory_recent: 0}
  approve_timeout: 1m
  permissions:
    core.fs.read: allow
    core.exec.ro: allow
    core.exec: approve
    core.fs.write: approve
  subagent: {enabled: true, max_parallel: 2, tools: [core.fs.read, core.exec.ro], budget: {model_calls: 6, tool_calls: 4, minutes: 2}}
credentials: []
notify: {admin: 甲}
gateway:
  mounts:
    - {id: code, path: ${ROOT}, exclude: [rooms], residents: {resident_beta_01: read-only}}
`);
  fs.writeFileSync(path.join(ROOT, 'rooms', '甲', 'room.yaml'), 'schema_version: 1\nid: resident_alpha_01\nname: 甲\nspecies: human\n');
  fs.writeFileSync(path.join(ROOT, 'rooms', '乙', 'room.yaml'), 'schema_version: 1\nid: resident_beta_01\nname: 乙\nspecies: agent\nplugins: [living-room]\nheartbeat: {enabled: false}\n');
  fs.writeFileSync(path.join(ROOT, 'rooms', '乙', 'SOUL.md'), 'You are 乙, a code assistant.');
  fs.writeFileSync(path.join(ROOT, 'apps', 'house', 'index.html'), '<!doctype html>');
  const saved = {}; for (const k of ['HOME', 'SAMEROOF_ROOT', 'SAMEROOF_LR', 'SAMEROOF_GATEWAY_SOCK', 'SAMEROOF_GATEWAY_TOKEN_FILE']) saved[k] = process.env[k];
  process.env.HOME = ROOT; process.env.SAMEROOF_ROOT = ROOT; delete process.env.SAMEROOF_LR;
  for (const m of ['../lib/room', '../lib/gateway-client', '../lib/subrun-manager', '../lib/subagent']) delete require.cache[require.resolve(m)];
  const { createLivingRoom } = require('@sameroof/living-room/server');
  const { createGateway } = require('@sameroof/gateway/server');
  const { run } = require('../lib/room');
  const gwDir = path.join(ROOT, 'gw'); fs.mkdirSync(gwDir, { recursive: true, mode: 0o700 });
  let room, gateway, ctrl = new AbortController(), adapterP;
  try {
    // --- real coordinator + real gateway, wired to each other ---
    room = createLivingRoom({ houseDir: ROOT, runDir: RUN_DIR, dataDir: path.join(ROOT, 'state'), port: 0, approvalLimit: 50, gatewayServiceTokenFile: path.join(gwDir, 'svc.token') });
    const port = (await room.listen()).port;
    fs.writeFileSync(path.join(gwDir, 'svc.token'), 'svc-e2e-token\n', { mode: 0o600 });
    fs.writeFileSync(path.join(RUN_DIR, 'living-room-tokens.json'), JSON.stringify({ resident_beta_01: room.tokenStore.issue('resident_beta_01').token }));
    const human = room.tokenStore.issue('resident_alpha_01').token;
    gateway = createGateway({ houseDir: ROOT, runDir: gwDir, stateDir: path.join(gwDir, 'state'), socketPath: path.join(gwDir, 'gateway.sock'), lockRequired: false, livingRoomPort: port, serviceTokenFile: path.join(gwDir, 'svc.token') });
    await gateway.listen(); gateway.startApprovalLoop();
    gateway.issueAdapterToken('resident_beta_01');
    process.env.SAMEROOF_GATEWAY_SOCK = gateway.socketPath; process.env.SAMEROOF_GATEWAY_TOKEN_FILE = path.join(gateway.adapterTokensDir, 'resident_beta_01');

    // --- scripted parent think() and subrun callOnce() ---
    const seenPrompts = []; let subModelCalls = 0;
    const think = async (system, user) => {
      seenPrompts.push(user);
      const parts = [];
      if (/你还在吗/.test(user)) parts.push('在的，子任务还在跑。');
      if (/【子任务结果】/.test(user)) parts.push(user.includes('interrupted') ? '子任务被中断了' : '找到了：' + (user.match(/(src\/[ab]\.js[^\n]*)/g) || []).join('; ') + (user.match(/(src\/[ab]\.js[^\n]*)/g) ? '' : '\n[DEBUG-MAIL]' + user.slice(user.indexOf('【子任务结果】'), user.indexOf('【子任务结果】') + 600)));
      if (parts.length) return parts.join('\n');
      if (/找出所有调 recall/.test(user)) return '收到，我去查。\nSUB: 找出 src/ 下所有调用 recall() 的位置 | 带上: 用 grep -rn "recall(" src/ ，只报文件名和行号 | 工具: core.exec.ro';
      return '(静默)';
    };
    const callOnce = async (messages, signal) => {
      subModelCalls++; if (subModelCalls === 1) await sleep(3000);   // make the subrun slow enough that a human message lands mid-subrun
      const last = messages[messages.length - 1].content;
      if (/【工具结果】/.test(last)) { assert.doesNotMatch(last, /output omitted/, 'subrun must see real output'); const hits = (last.match(/src\/[ab]\.js:\d+:[^\n]*/g) || []); return { text: `callers: ${hits.join('; ')}`, usage: { prompt_tokens: 1, completion_tokens: 1 } }; }
      assert.equal(messages.length, 2, 'zero context: system + brief only');
      assert.match(messages[0].content, /子任务执行体/);
      return { text: 'TOOL: core.exec.ro {"argv":["/bin/sh","-lc","grep -rn \\"recall(\\" src/"],"cwd":{"root_id":"code","path":""},"timeout_ms":10000}', usage: { prompt_tokens: 1, completion_tokens: 1 } };
    };
    adapterP = run('乙', 'broker-direct', think, { signal: ctrl.signal, lr: 'http://127.0.0.1:' + port, callOnce });
    await until(async () => ((await req(port, '/members', { token: human })).body || []).some(m => m.id === 'resident_beta_01' && m.online), 'adapter online');

    // 1. human asks; parent emits SUB:
    await req(port, '/say', { method: 'POST', token: human, body: { text: '@乙 找出所有调 recall() 的地方' } });
    const first = await until(async () => ((await req(port, '/history?limit=20', { token: human })).body || []).find(m => m.from_id === 'resident_beta_01' && /我去查/.test(m.text)), 'parent acknowledges');
    assert.doesNotMatch(first.text, /SUB:/, 'SUB: line stripped from the public reply');

    // 2. human talks during the subrun — must be answered, not blocked
    await req(port, '/say', { method: 'POST', token: human, body: { text: '@乙 你还在吗' } });
    await until(async () => ((await req(port, '/history?limit=20', { token: human })).body || []).find(m => m.from_id === 'resident_beta_01' && /在的/.test(m.text)), 'human answered mid-subrun');

    // 3. subrun completes with NO human click → mailbox → re-wake → answer
    const answer = await until(async () => ((await req(port, '/history?limit=30', { token: human })).body || []).find(m => m.from_id === 'resident_beta_01' && /找到了/.test(m.text)), 'parent reports subrun result', 30000);
    assert.match(answer.text, /src\/a\.js:2/); assert.match(answer.text, /src\/b\.js:1/); assert.doesNotMatch(answer.text, /c\.js/);
    assert.equal((await req(port, '/approval', { token: human })).body.filter(a => a.status === 'pending').length, 0, 'no approval card was ever created');
    assert.equal(subModelCalls, 2);

    // 4. contract B: the gateway's result DM for the subrun intent never entered the parent's prompt as a gateway result
    assert.ok(!seenPrompts.some(p => /网关结果|\[result\]/.test(p) && /grep -rn/.test(p)), 'subrun result DM did not reach the parent prompt');
    const mailFile = path.join(ROOT, 'rooms', '乙', 'state', 'mailbox.jsonl'); assert.ok(fs.existsSync(mailFile));
    const items = fs.readFileSync(mailFile, 'utf8').trim().split('\n').map(JSON.parse); assert.equal(items.length, 1); assert.equal(items[0].status, 'ok'); assert.equal(items[0].consumed, true); assert.equal(items[0].attempts[0].exit, 'say');
    // gateway audit: policy_allow, run_id = the sub id
    const audit = gateway.state.db.prepare("SELECT details_json FROM audit WHERE event='decided'").all().map(r => JSON.parse(r.details_json));
    assert.ok(audit.some(a => a.decision_source === 'policy_allow'));
    assert.equal(gateway.state.db.prepare('SELECT run_id FROM intents').get().run_id, items[0].sub_id);
    // transcript on disk
    const tr = fs.readdirSync(path.join(ROOT, 'rooms', '乙', 'state', 'subruns')); assert.equal(tr.length, 1); assert.equal(tr[0], items[0].sub_id + '.jsonl');
  } catch (e) {
    try { console.error('MAILBOX:', fs.readFileSync(path.join(ROOT, 'rooms', '乙', 'state', 'mailbox.jsonl'), 'utf8').slice(0, 1500)); } catch {}
    try { for (const f of fs.readdirSync(path.join(ROOT, 'rooms', '乙', 'state', 'subruns'))) console.error('TRANSCRIPT', f, fs.readFileSync(path.join(ROOT, 'rooms', '乙', 'state', 'subruns', f), 'utf8').slice(0, 2500)); } catch {}
    throw e;
  } finally {
    ctrl.abort(); if (adapterP) await Promise.race([adapterP, sleep(6000)]);
    if (gateway) await gateway.close().catch(() => {}); if (room) await room.close().catch(() => {});
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
});
