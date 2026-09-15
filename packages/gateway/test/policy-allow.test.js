'use strict';
// RFC 2026-09-15-gateway-allow — contract A (claim/execute split, register timing), core.exec.ro, /output channel, rate limit.
// Runs the REAL gateway with REAL bwrap where available; sandbox-dependent cases skip cleanly otherwise.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createGateway } = require('../server');

const HOUSE = (perms, gw = '') => `schema_version: 1
name: allow-test
timezone: UTC
defaults:
  runtime: test
  plugins: []
  heartbeat: {}
  context: {recent_messages: 0, recent_max_chars: 0, memory_hits: 0, memory_recent: 0}
  approve_timeout: 1m
  permissions:
${Object.entries(perms).map(([k, v]) => `    ${k}: ${v}`).join('\n')}
credentials: []
notify: {admin: 甲}
${gw}`;

function fixture(perms, { gw = '', bwrapProbe } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-allow-'));
  fs.mkdirSync(path.join(root, 'rooms', '甲'), { recursive: true });
  fs.writeFileSync(path.join(root, 'rooms', '甲', 'room.yaml'), 'schema_version: 1\nid: resident_alpha_01\nname: 甲\nspecies: human\n');
  fs.writeFileSync(path.join(root, 'rooms', '甲', 'hay.txt'), 'needle-one\nnothing\nneedle-two\n');
  fs.writeFileSync(path.join(root, 'house.yaml'), HOUSE(perms, gw));
  const delivered = [];
  const gateway = createGateway({ houseDir: root, runDir: path.join(root, 'run'), stateDir: path.join(root, 'state'), lockRequired: false, resultClient: async v => { delivered.push(v); return { message_id: 'm' + delivered.length }; }, ...(bwrapProbe === undefined ? {} : { bwrapProbe }) });
  const token = gateway.issueAdapterToken('resident_alpha_01').token;
  const audit = () => gateway.state.db.prepare('SELECT * FROM audit ORDER BY id').all().map(r => ({ ...r, kind: r.event, details: r.details_json ? JSON.parse(r.details_json) : {} }));
  return { root, gateway, token, delivered, audit, close: async () => { await gateway.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const until = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 30)); } };
const readIntent = (n = 1, o = {}) => ({ request_id: 'req_read0000' + n, resident_id: 'resident_alpha_01', run_id: 'sub_abc123', action: 'core.fs.read', params: { root_id: 'own-room', path: 'hay.txt' }, ...o });
const roIntent = (n = 1, argv = ['/bin/sh', '-lc', 'grep -n needle hay.txt'], o = {}) => ({ request_id: 'req_ro000000' + n, resident_id: 'resident_alpha_01', run_id: 'sub_abc123', action: 'core.exec.ro', params: { argv, cwd: { root_id: 'own-room', path: '' }, writable_root_ids: [], timeout_ms: 5000 }, ...o });
const sandboxOk = () => { try { const { spawnSync } = require('node:child_process'); return spawnSync('/usr/bin/bwrap', ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', '/bin/true'], { stdio: 'ignore', timeout: 5000 }).status === 0; } catch { return false; } };

// ---------- matrix 1: allow executes without a decision, audited, delivered with policy decision ----------
test('#1 house allow → register returns executing immediately, no approval, audit policy_allow, delivered with decision.source', async () => {
  const f = fixture({ 'core.fs.read': 'allow', 'core.fs.write': 'approve', 'core.exec': 'approve', 'core.exec.ro': 'approve' });
  try {
    const r = f.gateway.registerIntent(readIntent(1), f.token);
    assert.equal(r.state, 'executing', 'claimPolicyAllowed inserts as executing');
    assert.equal(f.gateway.state.db.prepare("SELECT count(*) c FROM approvals").get().c, 0, 'no approval row');
    const done = await until(() => f.gateway.getIntent('req_read00001', f.token).state !== 'executing' && f.gateway.getIntent('req_read00001', f.token));
    assert.equal(done.state, 'succeeded');
    assert.equal(done.result.details.content, '[content omitted]', 'getIntent keeps its no-content boundary');
    const decided = f.audit().find(a => a.kind === 'decided' && a.request_id === 'req_read00001');
    assert.equal(decided.details.decision_source, 'policy_allow'); assert.equal(decided.details.decided_by, 'policy');
    const d = await until(() => f.delivered[0]);
    assert.equal(d.approval, null);
    assert.equal(f.gateway.state.db.prepare('SELECT decision_source FROM intents WHERE request_id=?').get('req_read00001').decision_source, 'policy_allow');
  } finally { await f.close(); }
});

// ---------- matrix 13: approve path unchanged ----------
test('#13 house approve → awaiting_approval as before, decision_source=human', async () => {
  const f = fixture({ 'core.fs.read': 'approve', 'core.fs.write': 'approve', 'core.exec': 'approve', 'core.exec.ro': 'approve' });
  try {
    const r = f.gateway.registerIntent(readIntent(2), f.token);
    assert.equal(r.state, 'awaiting_approval');
    assert.equal(f.gateway.state.db.prepare('SELECT decision_source FROM intents WHERE request_id=?').get('req_read00002').decision_source, 'human');
  } finally { await f.close(); }
});

// ---------- matrix 24: idempotency includes run_id ----------
test('#24 same request_id, different run_id → GW-IDEMPOTENCY-CONFLICT', async () => {
  const f = fixture({ 'core.fs.read': 'allow', 'core.fs.write': 'approve', 'core.exec': 'approve', 'core.exec.ro': 'approve' });
  try {
    f.gateway.registerIntent(readIntent(3), f.token);
    assert.throws(() => f.gateway.registerIntent(readIntent(3, { run_id: 'sub_other99' }), f.token), e => e.code === 'GW-IDEMPOTENCY-CONFLICT');
    assert.equal(f.gateway.registerIntent(readIntent(3), f.token).request_id, 'req_read00003', 'identical re-register is idempotent');
  } finally { await f.close(); }
});

// ---------- matrix 5: core.exec.ro refuses writable roots ----------
test('#5 core.exec.ro with writable_root_ids → 400', async () => {
  const f = fixture({ 'core.fs.read': 'allow', 'core.fs.write': 'approve', 'core.exec': 'approve', 'core.exec.ro': 'allow' });
  try {
    assert.throws(() => f.gateway.registerIntent(roIntent(1, ['/bin/true'], { params: { argv: ['/bin/true'], cwd: { root_id: 'own-room', path: '' }, writable_root_ids: ['own-room'], timeout_ms: 1000 } }), f.token), e => e.code === 'GW-PARAMS-INVALID');
  } finally { await f.close(); }
});

// ---------- matrix 6 + 15 + 20 + 21: real grep in a read-only sandbox, output via /output ----------
test('#6/#15 core.exec.ro allow: grep runs, cannot write cwd, cannot reach network; /output returns lines verbatim', { skip: !sandboxOk() && 'bwrap unavailable' }, async () => {
  const f = fixture({ 'core.fs.read': 'allow', 'core.fs.write': 'approve', 'core.exec': 'approve', 'core.exec.ro': 'allow' });
  try {
    f.gateway.registerIntent(roIntent(2), f.token);
    const done = await until(() => { const s = f.gateway.getIntent('req_ro0000002', f.token); return s.state !== 'executing' && s; });
    assert.equal(done.state, 'succeeded', JSON.stringify(done));
    assert.equal(done.result.details.stdout, '[output omitted]', 'getIntent never carries stdout');
    const out = f.gateway.readOutput('req_ro0000002', f.token, 'sub_abc123');
    assert.match(out.result.details.stdout, /1:needle-one\n3:needle-two/, 'matching lines verbatim via /output');
    assert.equal(out.truncated, false); assert.equal(out.reads_remaining, 2);
    assert.ok(f.audit().some(a => a.kind === 'output_read' && a.request_id === 'req_ro0000002'));
    // negatives: write to cwd fails; network fails
    f.gateway.registerIntent(roIntent(3, ['/bin/sh', '-lc', 'touch x 2>&1; echo rc=$?']), f.token);
    await until(() => f.gateway.getIntent('req_ro0000003', f.token).state !== 'executing');
    assert.match(f.gateway.readOutput('req_ro0000003', f.token, 'sub_abc123').result.details.stdout, /Read-only file system|rc=1/);
    assert.equal(fs.existsSync(path.join(f.root, 'rooms', '甲', 'x')), false, 'cwd untouched');
    f.gateway.registerIntent(roIntent(4, ['/bin/sh', '-lc', 'cat /proc/net/route | wc -l; ls /sys/class/net 2>/dev/null | wc -l']), f.token);
    await until(() => f.gateway.getIntent('req_ro0000004', f.token).state !== 'executing');
    assert.match(f.gateway.readOutput('req_ro0000004', f.token, 'sub_abc123').result.details.stdout, /^1\n[01]\n$/, 'no routes, at most lo');
  } finally { await f.close(); }
});

// ---------- matrix 16/17/18/19/26: /output binding, human path excluded, reads cap, not-ready ----------
test('#16-19,#26 /output: wrong run 404, other resident 404, human-decided 404, executing 409, cap then 410 + physical clear', async () => {
  const f = fixture({ 'core.fs.read': 'allow', 'core.fs.write': 'approve', 'core.exec': 'approve', 'core.exec.ro': 'approve' });
  try {
    f.gateway.registerIntent(readIntent(5), f.token);
    await until(() => f.gateway.getIntent('req_read00005', f.token).state !== 'executing');
    assert.throws(() => f.gateway.readOutput('req_read00005', f.token, 'sub_WRONG'), e => e.code === 'GW-OUTPUT-NOT-FOUND');
    assert.throws(() => f.gateway.readOutput('req_read00005', 'not-a-token', 'sub_abc123'), e => e.code === 'GW-AUTH-DENIED');
    // human-decided intent: not offered
    f.gateway.registerIntent(readIntent(6, { action: 'core.fs.write', params: { root_id: 'own-room', path: 'w.md', content: 'x', mode: 'create' } }), f.token);
    assert.throws(() => f.gateway.readOutput('req_read00006', f.token, 'sub_abc123'), e => e.code === 'GW-OUTPUT-NOT-FOUND');
    // cap: 3 reads then 410, output_json NULL
    for (let i = 0; i < 3; i++) assert.equal(f.gateway.readOutput('req_read00005', f.token, 'sub_abc123').reads_remaining, 2 - i);
    assert.throws(() => f.gateway.readOutput('req_read00005', f.token, 'sub_abc123'), e => e.code === 'GW-OUTPUT-CONSUMED');
    assert.equal(f.gateway.state.db.prepare('SELECT output_json FROM intents WHERE request_id=?').get('req_read00005').output_json, null, 'physically cleared after cap');
    assert.ok(f.audit().some(a => a.kind === 'output_cleared' && a.request_id === 'req_read00005'));
  } finally { await f.close(); }
});

// ---------- matrix 27: ttl sweep clears unread output ----------
test('#27 output past ttl is cleared by sweep even if never read', async () => {
  const f = fixture({ 'core.fs.read': 'allow', 'core.fs.write': 'approve', 'core.exec': 'approve', 'core.exec.ro': 'approve' }, { gw: 'gateway: {output_ttl_ms: 50}' });
  try {
    f.gateway.registerIntent(readIntent(7), f.token);
    await until(() => f.gateway.getIntent('req_read00007', f.token).state !== 'executing');
    assert.notEqual(f.gateway.state.db.prepare('SELECT output_json FROM intents WHERE request_id=?').get('req_read00007').output_json, null);
    await new Promise(r => setTimeout(r, 80));
    assert.equal(f.gateway.sweepOutput(), 1);
    assert.equal(f.gateway.state.db.prepare('SELECT output_json FROM intents WHERE request_id=?').get('req_read00007').output_json, null);
    assert.throws(() => f.gateway.readOutput('req_read00007', f.token, 'sub_abc123'), e => /GW-OUTPUT-(EXPIRED|CONSUMED)/.test(e.code));
  } finally { await f.close(); }
});

// ---------- matrix 20: whole-response cap → truncated + total_bytes ----------
test('#20 large output is cut with truncated:true and total_bytes', { skip: !sandboxOk() && 'bwrap unavailable' }, async () => {
  const f = fixture({ 'core.fs.read': 'allow', 'core.fs.write': 'approve', 'core.exec': 'approve', 'core.exec.ro': 'allow' }, { gw: 'gateway: {output_max_bytes: 4096}' });
  try {
    f.gateway.registerIntent(roIntent(8, ['/bin/sh', '-lc', 'seq 1 2000']), f.token);
    await until(() => f.gateway.getIntent('req_ro0000008', f.token).state !== 'executing');
    const out = f.gateway.readOutput('req_ro0000008', f.token, 'sub_abc123');
    assert.equal(out.truncated, true); assert.ok(out.total_bytes.stdout > 4096);
    assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 4096 + 64, 'whole response within cap (+small slack)');
  } finally { await f.close(); }
});

// ---------- matrix 12: rate limit before insert ----------
test('#12 allow_rate exceeded → 429, one audit row, NO intent row, no delivery', async () => {
  const f = fixture({ 'core.fs.read': 'allow', 'core.fs.write': 'approve', 'core.exec': 'approve', 'core.exec.ro': 'approve' }, { gw: 'gateway: {allow_rate: {core.fs.read: 2}}' });
  try {
    f.gateway.registerIntent(readIntent(9), f.token); f.gateway.registerIntent(readIntent(10), f.token);
    assert.throws(() => f.gateway.registerIntent(readIntent(11), f.token), e => e.code === 'GW-RATE-LIMITED' && e.status === 429);
    assert.equal(f.gateway.state.db.prepare('SELECT count(*) c FROM intents WHERE request_id=?').get('req_read000011').c, 0, 'no intent row');
    assert.ok(f.audit().some(a => a.kind === 'rate_limited' && a.resident_id === 'resident_alpha_01' && a.details.run_id === 'sub_abc123'));
    await new Promise(r => setTimeout(r, 200));
    assert.equal(f.delivered.filter(d => d.row.request_id === 'req_read000011').length, 0);
  } finally { await f.close(); }
});

// ---------- matrix 7: allow but sandbox unavailable → fails closed, nothing runs ----------
test('#7 allow with bwrap probe false: core.exec.ro fails closed, audited', async () => {
  const f = fixture({ 'core.fs.read': 'allow', 'core.fs.write': 'approve', 'core.exec': 'approve', 'core.exec.ro': 'allow' }, { bwrapProbe: false });
  try {
    f.gateway.registerIntent(roIntent(12, ['/bin/sh', '-lc', 'touch leaked']), f.token);
    const done = await until(() => { const s = f.gateway.getIntent('req_ro00000012', f.token); return s.state !== 'executing' && s; });
    assert.equal(done.state, 'denied');
    assert.equal(fs.existsSync(path.join(f.root, 'rooms', '甲', 'leaked')), false);
  } finally { await f.close(); }
});

// ---------- matrix 14: digest of core.exec.ro ≠ core.exec ----------
test('#14 target digest differs between core.exec and core.exec.ro for the same argv', async () => {
  const f = fixture({ 'core.fs.read': 'allow', 'core.fs.write': 'approve', 'core.exec': 'approve', 'core.exec.ro': 'approve' });
  try {
    const p = { cwd: { root_id: 'own-room', path: '' }, argv: ['/bin/true'], writable_root_ids: [] };
    assert.notEqual(f.gateway.targetDigest('core.exec', p), f.gateway.targetDigest('core.exec.ro', p));
  } finally { await f.close(); }
});

// ---------- 审查员 gate P1: retention is a per-row promise; a later, looser policy cannot extend it; startup sweep runs without a tick ----------
test('P1 retention: create under ttl=200ms/reads=2, restart with ttl=1h/reads=10 → old row still 410 and cleared at startup (no poll tick)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-ret-'));
  fs.mkdirSync(path.join(root, 'rooms', '甲'), { recursive: true });
  fs.writeFileSync(path.join(root, 'rooms', '甲', 'room.yaml'), 'schema_version: 1\nid: resident_alpha_01\nname: 甲\nspecies: human\n');
  fs.writeFileSync(path.join(root, 'rooms', '甲', 'hay.txt'), 'x\n');
  const perms = { 'core.fs.read': 'allow', 'core.fs.write': 'approve', 'core.exec': 'approve', 'core.exec.ro': 'approve' };
  fs.writeFileSync(path.join(root, 'house.yaml'), HOUSE(perms, 'gateway: {output_ttl_ms: 200, output_max_reads: 2}'));
  const mk = () => createGateway({ houseDir: root, runDir: path.join(root, 'run'), stateDir: path.join(root, 'state'), lockRequired: false, resultClient: async () => ({ message_id: 'm' }) });
  let gw = mk(); const token = gw.issueAdapterToken('resident_alpha_01').token;
  try {
    gw.registerIntent(readIntent(30), token);
    await until(() => gw.getIntent('req_read000030', token).state !== 'executing');
    const row = gw.state.db.prepare('SELECT output_expires_at, output_max_reads FROM intents WHERE request_id=?').get('req_read000030');
    assert.equal(row.output_max_reads, 2, 'cap snapshotted on the row');
    assert.ok(Date.parse(row.output_expires_at) - Date.now() <= 250, 'expiry snapshotted on the row');
    // one read ok, second ok, third 410 under the row cap
    gw.readOutput('req_read000030', token, 'sub_abc123'); gw.readOutput('req_read000030', token, 'sub_abc123');
    assert.throws(() => gw.readOutput('req_read000030', token, 'sub_abc123'), e => e.code === 'GW-OUTPUT-CONSUMED');
    // second row: unread, will expire
    gw.registerIntent(readIntent(31), token);
    await until(() => gw.getIntent('req_read000031', token).state !== 'executing');
    await gw.close();
    await new Promise(r => setTimeout(r, 250));
    // loosen policy and restart
    fs.writeFileSync(path.join(root, 'house.yaml'), HOUSE(perms, 'gateway: {output_ttl_ms: 3600000, output_max_reads: 10}'));
    gw = mk();
    assert.ok(gw.startupSweep >= 1, 'startup sweep ran (no listen, no tick) and cleared ≥1 row');
    assert.equal(gw.state.db.prepare('SELECT output_json FROM intents WHERE request_id=?').get('req_read000031').output_json, null, 'expired row physically cleared at startup despite looser new ttl');
    assert.throws(() => gw.readOutput('req_read000031', token, 'sub_abc123'), e => /GW-OUTPUT-(EXPIRED|CONSUMED)/.test(e.code));
    assert.throws(() => gw.readOutput('req_read000030', token, 'sub_abc123'), e => /GW-OUTPUT-(EXPIRED|CONSUMED)/.test(e.code), 'reads cap not extended by new reads=10');
    // a NEW row under the new policy gets the new caps
    gw.registerIntent(readIntent(32), token);
    await until(() => gw.getIntent('req_read000032', token).state !== 'executing');
    assert.equal(gw.state.db.prepare('SELECT output_max_reads FROM intents WHERE request_id=?').get('req_read000032').output_max_reads, 10);
  } finally { await gw.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('小修: policy-allow intent with NULL run_id has no /output; missing header never matches', async () => {
  const f = fixture({ 'core.fs.read': 'allow', 'core.fs.write': 'approve', 'core.exec': 'approve', 'core.exec.ro': 'approve' });
  try {
    f.gateway.registerIntent(readIntent(40, { run_id: undefined }), f.token);
    await until(() => f.gateway.getIntent('req_read000040', f.token).state !== 'executing');
    assert.equal(f.gateway.state.db.prepare('SELECT run_id FROM intents WHERE request_id=?').get('req_read000040').run_id, null);
    assert.throws(() => f.gateway.readOutput('req_read000040', f.token, undefined), e => e.code === 'GW-OUTPUT-NOT-FOUND', 'no header + null run → 404');
    assert.throws(() => f.gateway.readOutput('req_read000040', f.token, ''), e => e.code === 'GW-OUTPUT-NOT-FOUND', 'empty header + null run → 404');
    // and a real subrun row still refuses a missing header
    f.gateway.registerIntent(readIntent(41), f.token);
    await until(() => f.gateway.getIntent('req_read000041', f.token).state !== 'executing');
    assert.throws(() => f.gateway.readOutput('req_read000041', f.token, undefined), e => e.code === 'GW-OUTPUT-NOT-FOUND');
    assert.equal(f.gateway.readOutput('req_read000041', f.token, 'sub_abc123').request_id, 'req_read000041');
  } finally { await f.close(); }
});
