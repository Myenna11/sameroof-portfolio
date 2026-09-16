'use strict';
// 审查员 gate: REAL adapter process (test-support/launch-adapter.js), production entry shape (no signal).
// SIGKILL mid-subrun → restart → exactly one `interrupted`, no re-execution, request index rebuilt BEFORE the startup inbox read
// (the gateway's result DM that arrived while we were dead is filtered, never enters the prompt), unknown request_id still wakes.
// SIGTERM mid-subrun → manager stops first, interrupted item written, clean exit.
const assert = require('node:assert/strict');
const fs = require('node:fs'); const http = require('node:http'); const os = require('node:os'); const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const sandboxOk = () => { try { const { spawnSync } = require('node:child_process'); return spawnSync('/usr/bin/bwrap', ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', '/bin/true'], { stdio: 'ignore', timeout: 5000 }).status === 0; } catch { return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, label, ms = 20000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout: ' + label); await sleep(100); } };
const req = (port, p, o = {}) => new Promise((res, rej) => { const b = o.body ? Buffer.from(JSON.stringify(o.body)) : null; const r = http.request({ hostname: '127.0.0.1', port, path: p, method: o.method || 'GET', headers: { ...(o.token ? { authorization: 'Bearer ' + o.token } : {}), ...(b ? { 'content-type': 'application/json', 'content-length': b.length } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let v; try { v = JSON.parse(s); } catch { v = s; } res({ status: x.statusCode, body: v }); }); }); r.on('error', rej); if (b) r.write(b); r.end(); });
const sockReq = (sock, p, o = {}) => new Promise((res, rej) => { const b = o.body ? Buffer.from(JSON.stringify(o.body)) : null; const r = http.request({ socketPath: sock, path: p, method: o.method || 'GET', headers: { ...(o.token ? { authorization: 'Bearer ' + o.token } : {}), ...(b ? { 'content-type': 'application/json', 'content-length': b.length } : {}), ...(o.headers || {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let v; try { v = JSON.parse(s); } catch { v = s; } res({ status: x.statusCode, body: v }); }); }); r.on('error', rej); if (b) r.write(b); r.end(); });

test('SIGKILL mid-subrun → restart: one interrupted, no re-exec, late known result filtered, unknown result wakes; SIGTERM → clean stop', { skip: !sandboxOk() && 'bwrap unavailable', timeout: 90000 }, async () => {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-life-')); const RUN_DIR = path.join(ROOT, '.sameroof', 'run'); const gwDir = path.join(ROOT, 'gw');
  for (const d of ['rooms/甲', 'rooms/乙/state', 'apps/house', 'state', 'src']) fs.mkdirSync(path.join(ROOT, d), { recursive: true }); fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 }); fs.mkdirSync(gwDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(ROOT, 'src', 'a.js'), 'recall(1);\n'); fs.writeFileSync(path.join(ROOT, 'src', 'b.js'), 'await recall(2);\n');
  fs.writeFileSync(path.join(ROOT, 'house.yaml'), `schema_version: 1\nname: life\ntimezone: UTC\ndefaults:\n  runtime: broker-direct\n  plugins: [living-room]\n  heartbeat: {enabled: false}\n  context: {recent_messages: 20, recent_max_chars: 4000, memory_hits: 0, memory_recent: 0}\n  approve_timeout: 1m\n  permissions: {core.fs.read: allow, core.exec.ro: allow, core.exec: approve, core.fs.write: approve}\n  subagent: {enabled: true, max_parallel: 2, tools: [core.fs.read, core.exec.ro], budget: {model_calls: 6, tool_calls: 4, minutes: 2}}\ncredentials: []\nnotify: {admin: 甲}\ngateway:\n  mounts:\n    - {id: code, path: ${ROOT}, exclude: [rooms], residents: {resident_beta_01: read-only}}\n`);
  fs.writeFileSync(path.join(ROOT, 'rooms', '甲', 'room.yaml'), 'schema_version: 1\nid: resident_alpha_01\nname: 甲\nspecies: human\n');
  fs.writeFileSync(path.join(ROOT, 'rooms', '乙', 'room.yaml'), 'schema_version: 1\nid: resident_beta_01\nname: 乙\nspecies: agent\nplugins: [living-room]\nheartbeat: {enabled: false}\n');
  fs.writeFileSync(path.join(ROOT, 'rooms', '乙', 'SOUL.md'), 'You are 乙.'); fs.writeFileSync(path.join(ROOT, 'apps', 'house', 'index.html'), '<!doctype html>');
  const { createLivingRoom } = require('@sameroof/living-room/server'); const { createGateway } = require('@sameroof/gateway/server');
  const room = createLivingRoom({ houseDir: ROOT, runDir: RUN_DIR, dataDir: path.join(ROOT, 'state'), port: 0, approvalLimit: 50, gatewayServiceTokenFile: path.join(gwDir, 'svc.token') });
  const port = (await room.listen()).port; fs.writeFileSync(path.join(gwDir, 'svc.token'), 'svc-lifecycle-token-0123456789abcdef0123456789\n', { mode: 0o600 });   // living-room requires ≥32 chars
  fs.writeFileSync(path.join(RUN_DIR, 'living-room-tokens.json'), JSON.stringify({ resident_beta_01: room.tokenStore.issue('resident_beta_01').token }));
  const human = room.tokenStore.issue('resident_alpha_01').token;
  const gateway = createGateway({ houseDir: ROOT, runDir: gwDir, stateDir: path.join(gwDir, 'state'), socketPath: path.join(gwDir, 'gateway.sock'), lockRequired: false, livingRoomPort: port, serviceTokenFile: path.join(gwDir, 'svc.token') });
  await gateway.listen(); gateway.startApprovalLoop(); const gwTok = gateway.issueAdapterToken('resident_beta_01').token;
  const env = { ...process.env, HOME: ROOT, SAMEROOF_ROOT: ROOT, SAMEROOF_LR: 'http://127.0.0.1:' + port, SAMEROOF_GATEWAY_SOCK: gateway.socketPath, SAMEROOF_GATEWAY_TOKEN_FILE: path.join(gateway.adapterTokensDir, 'resident_beta_01'), ROOM: '乙' };
  const launch = (extra = {}) => { const p = spawn(process.execPath, [path.join(__dirname, '..', 'test-support', 'launch-adapter.js')], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); p.out = ''; p.stdout.on('data', d => p.out += d); p.stderr.on('data', d => p.out += d); return p; };
  const trDir = path.join(ROOT, 'rooms', '乙', 'state', 'subruns'); const mailFile = path.join(ROOT, 'rooms', '乙', 'state', 'mailbox.jsonl');
  const mail = () => fs.existsSync(mailFile) ? fs.readFileSync(mailFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const online = () => until(async () => ((await req(port, '/members', { token: human })).body || []).some(m => m.id === 'resident_beta_01' && m.online), 'online');
  let A, B, C, D;
  try {
    // ---- run A: subrun's 2nd model call sleeps 8s; kill inside that window, AFTER the tool ran and its result DM was delivered ----
    A = launch({ SUB_DELAY_MS: '8000' }); await online();
    await req(port, '/say', { method: 'POST', token: human, body: { text: '@乙 找出所有调 recall() 的地方' } });
    await until(() => fs.existsSync(trDir) && fs.readdirSync(trDir).some(f => fs.readFileSync(path.join(trDir, f), 'utf8').includes('"ev":"tool_done"')), 'tool executed');
    const subFile = fs.readdirSync(trDir)[0]; const subId = subFile.replace(/\.jsonl$/, '');
    const reqId = JSON.parse(fs.readFileSync(path.join(trDir, subFile), 'utf8').split('\n').find(l => l.includes('"tool_register"'))).request_id;
    await until(() => gateway.state.db.prepare("SELECT count(*) c FROM results WHERE request_id=? AND delivered_at IS NOT NULL").get(reqId).c === 1 || room.db.prepare("SELECT count(*) c FROM messages WHERE kind='result' AND json_extract(meta,'$.request_id')=?").get(reqId).c === 1, 'result DM delivered');
    assert.ok(!/网关结果/.test(A.out), 'live filter: result DM did not wake A');
    A.kill('SIGKILL'); await new Promise(r => A.on('exit', r));
    assert.ok(!fs.readFileSync(path.join(trDir, subFile), 'utf8').includes('"ev":"end"'), 'transcript has no end (crashed mid-subrun)');
    assert.equal(mail().length, 0, 'nothing in mailbox yet');
    const intentsBefore = gateway.state.db.prepare('SELECT count(*) c FROM intents').get().c;

    // ---- run B: restart. Startup inbox contains the late result DM (unread). Must be filtered; one interrupted item; no re-exec ----
    B = launch({ SUB_DELAY_MS: '0' }); await online();
    await until(() => mail().some(i => i.status === 'interrupted'), 'interrupted item');
    await until(() => /子任务被中断了/.test(B.out), 'parent reported the interruption');
    const items = mail(); assert.equal(items.filter(i => i.status === 'interrupted').length, 1); assert.equal(items[0].sub_id, subId); assert.deepEqual(items[0].request_ids, [reqId]);
    assert.ok(!/网关结果/.test(B.out), 'late known result DM never woke B / never entered its prompt');
    for (const raw of B.out.split('PROMPT ').slice(1)) {                       // request_id may appear ONLY inside 【子任务结果】 (the interrupted item lists its intents), never in the coordinator-inbox block
      let pr; try { pr = JSON.parse(raw.split('\n')[0]); } catch { continue; }
      const inboxAt = pr.indexOf('【你没读的客厅记录'); const idAt = pr.indexOf(reqId);
      if (idAt >= 0) assert.ok(inboxAt < 0 || idAt < inboxAt, 'request_id leaked into the coordinator-inbox block: ' + pr.slice(Math.max(0, idAt - 80), idAt + 80));
    }
    assert.equal(gateway.state.db.prepare('SELECT count(*) c FROM intents').get().c, intentsBefore, 'no re-execution on restart');
    assert.ok(fs.readFileSync(path.join(trDir, subFile), 'utf8').includes('"status":"interrupted"'), 'transcript closed as interrupted');
    // ---- unknown request_id with a sub_-looking run_id: must wake normally ----
    const unk = 'req_unknown' + Date.now().toString(36);
    await sockReq(gateway.socketPath, '/v1/intents', { method: 'POST', token: gwTok, headers: { 'idempotency-key': unk }, body: { request_id: unk, resident_id: 'resident_beta_01', run_id: 'sub_notmine1', action: 'core.fs.read', params: { root_id: 'code', path: 'src/a.js' } } });
    await until(() => /看到一条网关结果/.test(B.out), 'unknown result woke the parent');
    B.kill('SIGTERM'); await new Promise(r => B.on('exit', r));

    // ---- run C: SIGTERM mid-subrun → manager stop → interrupted written → clean exit ----
    fs.rmSync(mailFile, { force: true }); for (const f of fs.readdirSync(trDir)) fs.unlinkSync(path.join(trDir, f));
    C = launch({ SUB_DELAY_MS: '8000' }); await online();
    await req(port, '/say', { method: 'POST', token: human, body: { text: '@乙 找出所有调 recall() 的地方' } });
    await until(() => fs.existsSync(trDir) && fs.readdirSync(trDir).some(f => fs.readFileSync(path.join(trDir, f), 'utf8').includes('"ev":"tool_done"')), 'C tool executed');
    const t0 = Date.now(); C.kill('SIGTERM'); const code = await new Promise(r => C.on('exit', r));
    assert.ok(Date.now() - t0 < 8000, 'exited before the subrun would have finished on its own'); assert.equal(code, 0, 'clean exit');
    assert.equal(mail().filter(i => i.status === 'interrupted').length, 1, 'SIGTERM path wrote the interrupted item before exiting');

    // ---- run D: SIGTERM while the sleep-time handover think NEVER resolves → bounded shutdown must still exit 0 within the deadline ----
    fs.rmSync(mailFile, { force: true }); for (const f of fs.readdirSync(trDir)) fs.unlinkSync(path.join(trDir, f));
    D = launch({ SUB_DELAY_MS: '8000', HANG_HANDOVER: '1', SAMEROOF_SHUTDOWN_MS: '4000' }); await online();
    await req(port, '/say', { method: 'POST', token: human, body: { text: '@乙 找出所有调 recall() 的地方' } });
    await until(() => fs.existsSync(trDir) && fs.readdirSync(trDir).some(f => fs.readFileSync(path.join(trDir, f), 'utf8').includes('"ev":"tool_done"')), 'D tool executed');
    const t1 = Date.now(); D.kill('SIGTERM'); const codeD = await new Promise(r => D.on('exit', r)); const tookD = Date.now() - t1;
    assert.ok(/HANDOVER_THINK_HANG/.test(D.out), 'the handover note think was actually entered and hung');
    assert.ok(tookD < 4000 + 3000, `exited within deadline+slack (took ${tookD}ms)`); assert.equal(codeD, 0, 'clean exit, not the hard-exit guard');
    assert.equal(mail().filter(i => i.status === 'interrupted').length, 1, 'interrupted item on disk');
    assert.ok(fs.existsSync(path.join(ROOT, 'rooms', '乙', 'handover', 'latest.md')), 'facts handover written before the note was abandoned');
    assert.ok(/便条超时|跳过便条|便条没写成/.test(D.out), 'note abandoned or skipped, logged');
  } catch (e) { for (const P of [A, B, C, D]) if (P) console.error('--- child out ---\n' + P.out.slice(-3000)); try { console.error('GW results:', JSON.stringify(gateway.state.db.prepare('SELECT request_id, message_id, delivered_at FROM results').all())); console.error('GW audit tail:', JSON.stringify(gateway.state.db.prepare('SELECT event, status, substr(details_json,1,160) d FROM audit ORDER BY id DESC LIMIT 4').all())); } catch (x) { console.error('dbg', x.message); } throw e; }
  finally {
    for (const P of [A, B, C, D]) if (P && P.exitCode === null && P.signalCode === null) P.kill('SIGKILL');
    await gateway.close().catch(() => {}); await room.close().catch(() => {}); fs.rmSync(ROOT, { recursive: true, force: true });
  }
});
