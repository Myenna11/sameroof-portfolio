'use strict';
// RFC matrix #23 — REAL gateway process, SIGKILLed after claimPolicyAllowed committed and before the sandbox is spawned.
// Expect on restart: row → failed_unknown, exactly one recovery audit + one result delivery, sandbox ran ZERO times
// (marker file the command would have created is absent), and the intent is never replayed on later restarts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');

const sandboxOk = () => { try { const { spawnSync } = require('node:child_process'); return spawnSync('/usr/bin/bwrap', ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', '/bin/true'], { stdio: 'ignore', timeout: 5000 }).status === 0; } catch { return false; } };
const until = async (fn, ms = 10000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 40)); } };
const req = (sock, p, o = {}) => new Promise((res, rej) => { const b = o.body ? Buffer.from(JSON.stringify(o.body)) : null; const r = http.request({ socketPath: sock, path: p, method: o.method || 'GET', headers: { ...(o.token ? { authorization: 'Bearer ' + o.token } : {}), ...(b ? { 'content-type': 'application/json', 'content-length': b.length } : {}), ...(o.headers || {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let v; try { v = JSON.parse(s); } catch { v = s; } res({ status: x.statusCode, body: v }); }); }); r.on('error', rej); if (b) r.write(b); r.end(); });

test('#23 kill gateway process between claim and sandbox spawn: failed_unknown, one recovery, zero executions, no replay', { skip: !sandboxOk() && 'bwrap unavailable', timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-crash-'));
  const runDir = path.join(root, 'run'), stateDir = path.join(root, 'state'), sock = path.join(runDir, 'gateway.sock'), marker = path.join(root, 'rooms', '甲', 'RAN');
  const faultFlag = path.join(root, 'fault-window-entered');
  fs.mkdirSync(path.join(root, 'rooms', '甲'), { recursive: true }); fs.mkdirSync(runDir, { recursive: true, mode: 0o700 }); fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, 'rooms', '甲', 'room.yaml'), 'schema_version: 1\nid: resident_alpha_01\nname: 甲\nspecies: human\n');
  fs.writeFileSync(path.join(root, 'house.yaml'), `schema_version: 1
name: crash
timezone: UTC
defaults:
  runtime: test
  plugins: []
  heartbeat: {}
  context: {recent_messages: 0, recent_max_chars: 0, memory_hits: 0, memory_recent: 0}
  approve_timeout: 1m
  permissions:
    core.exec: allow
credentials: []
notify: {admin: 甲}
gateway:
  mounts:
    - {id: project, path: ${root}, residents: {resident_alpha_01: read-write}}
`);
  // living-room stand-in: counts result deliveries
  const deliveries = [];
  const lr = http.createServer((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => {
    s.writeHead(200, { 'content-type': 'application/json' });
    if (q.method === 'POST' && q.url === '/internal/gateway/results') { deliveries.push(JSON.parse(b)); return s.end(JSON.stringify({ message_id: 'm' + deliveries.length })); }
    return s.end(JSON.stringify({ decisions: [], items: [], results: [] }));   // approval-results poll: nothing to decide
  }); });
  await new Promise(r => lr.listen(0, '127.0.0.1', r)); const lrPort = lr.address().port;
  fs.writeFileSync(path.join(stateDir, 'living-room.token'), 'svc-token\n', { mode: 0o600 });

  // real deployment shape: the process requires house.lock — generate it with the real CLI
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'cli', 'index.js'), 'lock', '--house', root], { stdio: 'pipe' });
  // adapter token: issue BEFORE any gateway process runs (the helper instance also runs startup recovery; nothing to recover yet)
  const { createGateway } = require('../server');
  const helper = createGateway({ houseDir: root, runDir, stateDir, socketPath: path.join(root, 'unused.sock'), lockRequired: false, bwrapProbe: false, resultClient: async () => ({}) });
  const token = helper.issueAdapterToken('resident_alpha_01').token; await helper.close();
  const env = { ...process.env, SAMEROOF_ROOT: root, HOME: root, SAMEROOF_GATEWAY_RUN_DIR: runDir, SAMEROOF_GATEWAY_STATE_DIR: stateDir, SAMEROOF_GATEWAY_SOCKET: sock, SAMEROOF_LIVING_ROOM_PORT: String(lrPort) };
  const startGateway = (extraEnv = {}) => spawn(process.execPath, [path.join(__dirname, '..', 'test-support', 'launch-gateway.js')], { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  const waitSock = () => until(() => fs.existsSync(sock));
  let gw1, gw2, gw3;
  try {
    // ---- run 1: with the fault window, register an allow intent, kill inside the window ----
    gw1 = startGateway({ SAMEROOF_GATEWAY_FAULT_BEFORE_SPAWN: faultFlag });
    let log1 = ''; gw1.stdout.on('data', d => log1 += d); gw1.stderr.on('data', d => log1 += d);
    await waitSock();
    const body = { request_id: 'req_crash00001', resident_id: 'resident_alpha_01', run_id: 'sub_crash1', action: 'core.exec', params: { argv: ['/bin/sh', '-lc', 'touch RAN'], cwd: { root_id: 'project', path: 'rooms/甲' }, writable_root_ids: ['project'], timeout_ms: 5000 } };
    const reg = await req(sock, '/v1/intents', { method: 'POST', token, body, headers: { 'idempotency-key': body.request_id } });
    assert.equal(reg.status, 200, JSON.stringify(reg.body)); assert.equal(reg.body.state, 'executing', 'claim committed');
    await until(() => fs.existsSync(faultFlag), 5000);           // we are now between claim and spawn
    assert.equal(fs.existsSync(marker), false, 'sandbox has NOT run yet');
    gw1.kill('SIGKILL'); await new Promise(r => gw1.on('exit', r));
    assert.equal(fs.existsSync(marker), false, 'still no execution after kill');
    const db = new Database(path.join(stateDir, 'gateway.db'), { readonly: true });
    assert.equal(db.prepare('SELECT status FROM intents WHERE request_id=?').get('req_crash00001').status, 'executing', 'row left in executing by the crash');
    db.close();

    // ---- run 2: normal restart ----
    try { fs.unlinkSync(sock); } catch {}
    gw2 = startGateway();
    await waitSock();
    const st = await until(async () => { const r = await req(sock, '/v1/intents/req_crash00001', { token }); return r.body.state === 'failed_unknown' ? r.body : null; });
    assert.equal(st.state, 'failed_unknown');
    assert.equal(st.result.error.code, 'GW-FAILED-UNKNOWN');
    await new Promise(r => setTimeout(r, 1500));               // let the delivery loop run
    assert.equal(fs.existsSync(marker), false, 'sandbox never ran — no replay on restart');
    const db2 = new Database(path.join(stateDir, 'gateway.db'), { readonly: true });
    const recov = db2.prepare("SELECT count(*) c FROM audit WHERE request_id=? AND event='executed' AND status='failed_unknown'").get('req_crash00001').c;
    assert.equal(recov, 1, 'exactly one recovery audit row');
    db2.close();
    assert.equal(deliveries.filter(d => d.request_id === 'req_crash00001').length, 1, 'exactly one result delivered');
    assert.equal(deliveries[0].status, 'failed_unknown');
    gw2.kill('SIGTERM'); await new Promise(r => gw2.on('exit', r));

    // ---- run 3: another restart must not re-recover or re-deliver ----
    try { fs.unlinkSync(sock); } catch {}
    gw3 = startGateway(); await waitSock(); await new Promise(r => setTimeout(r, 1500));
    const db3 = new Database(path.join(stateDir, 'gateway.db'), { readonly: true });
    assert.equal(db3.prepare("SELECT count(*) c FROM audit WHERE request_id=? AND event='executed'").get('req_crash00001').c, 1, 'no second recovery on a later restart');
    db3.close();
    assert.equal(deliveries.filter(d => d.request_id === 'req_crash00001').length, 1, 'no second delivery');
    assert.equal(fs.existsSync(marker), false);
  } finally {
    for (const g of [gw1, gw2, gw3]) if (g && g.exitCode === null && g.signalCode === null) g.kill('SIGKILL');
    await new Promise(r => lr.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
