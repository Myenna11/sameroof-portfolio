'use strict';
// 维护者 2026-09-15 授权模型：代码目录只读不问；rooms/ 挂着但每次都要人点（gate: approve）；exclude 子树在沙箱里是空的。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createGateway } = require('../server');

const sandboxOk = () => { try { const { spawnSync } = require('node:child_process'); return spawnSync('/usr/bin/bwrap', ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', '/bin/true'], { stdio: 'ignore', timeout: 5000 }).status === 0; } catch { return false; } };
const until = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 30)); } };

function fixture(mountsYaml) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-gate-'));
  const repo = root;   // the house root itself, exactly like /root/sameroof: packages/ docs/ AND rooms/<resident>/
  for (const d of ['rooms/甲', 'rooms/乙', 'packages', 'docs']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'rooms', '甲', 'room.yaml'), 'schema_version: 1\nid: resident_alpha_01\nname: 甲\nspecies: human\n');
  fs.writeFileSync(path.join(root, 'rooms', '乙', 'room.yaml'), 'schema_version: 1\nid: resident_beta_01\nname: 乙\nspecies: human\n');
  fs.writeFileSync(path.join(repo, 'packages', 'code.js'), 'recall(1);\n');
  fs.writeFileSync(path.join(repo, 'docs', 'note.md'), 'hello\n');
  fs.writeFileSync(path.join(root, 'rooms', '乙', 'SECRET.md'), 'beta-private\n');
  fs.writeFileSync(path.join(root, 'house.yaml'), `schema_version: 1
name: gate-test
timezone: UTC
defaults:
  runtime: test
  plugins: []
  heartbeat: {}
  context: {recent_messages: 0, recent_max_chars: 0, memory_hits: 0, memory_recent: 0}
  approve_timeout: 1m
  permissions:
    core.fs.read: allow
    core.exec.ro: allow
    core.exec: approve
    core.fs.write: approve
credentials: []
notify: {admin: 甲}
gateway:
  mounts:
${mountsYaml.replace(/REPO/g, repo)}
`);
  const delivered = [];
  const gateway = createGateway({ houseDir: root, runDir: path.join(root, 'run'), stateDir: path.join(root, 'state'), lockRequired: false, resultClient: async v => { delivered.push(v); return { message_id: 'm' }; } });
  const token = gateway.issueAdapterToken('resident_alpha_01').token;
  return { root, repo, gateway, token, delivered, close: async () => { await gateway.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const rd = (n, root_id, p, o = {}) => ({ request_id: 'req_gate0000' + n, resident_id: 'resident_alpha_01', run_id: 'sub_g1', action: 'core.fs.read', params: { root_id, path: p }, ...o });
const ro = (n, root_id, argv) => ({ request_id: 'req_gatero00' + n, resident_id: 'resident_alpha_01', run_id: 'sub_g1', action: 'core.exec.ro', params: { argv, cwd: { root_id, path: '' }, writable_root_ids: [], timeout_ms: 5000 } });

test('plain mount containing other rooms: allowed; other room still refused for fs.read (existing hard rule), own docs readable', async () => {
  const f = fixture(`    - {id: code, path: REPO, residents: {resident_alpha_01: read-only}}`);
  try {
    assert.equal(f.gateway.registerIntent(rd(1, 'code', 'docs/note.md'), f.token).state, 'executing');
    assert.throws(() => f.gateway.registerIntent(rd(11, 'code', 'rooms/乙/SECRET.md'), f.token), e => e.code === 'GW-PATH-PROTECTED');
  } finally { await f.close(); }
});

test('code mount with exclude:[rooms] → allow path; excluded path refused; rooms mount gate:approve → awaiting_approval even though fs.read is allow', async () => {
  const f = fixture(`    - {id: code, path: REPO, exclude: [rooms], residents: {resident_alpha_01: read-only}}
    - {id: rooms, path: REPO/rooms, gate: approve, residents: {resident_alpha_01: read-only}}`);
  try {
    // allow: docs via code mount
    assert.equal(f.gateway.registerIntent(rd(2, 'code', 'docs/note.md'), f.token).state, 'executing');
    const r2 = await until(() => { const s = f.gateway.getIntent('req_gate00002', f.token); return s.state !== 'executing' && s; });
    assert.equal(r2.state, 'succeeded');
    // excluded subtree via code mount → refused at registration
    assert.throws(() => f.gateway.registerIntent(rd(3, 'code', 'rooms/乙/SECRET.md'), f.token), e => e.code === 'GW-PATH-EXCLUDED');
    // same file via the gated rooms mount → allowed to ASK, but never auto-executes
    const r4 = f.gateway.registerIntent(rd(4, 'rooms', '乙/SECRET.md'), f.token);
    assert.equal(r4.state, 'awaiting_approval', 'gate: approve caps fs.read allow → approve');
    assert.equal(f.gateway.state.db.prepare('SELECT decision_source FROM intents WHERE request_id=?').get('req_gate00004').decision_source, 'human');
    // exec.ro with cwd in the gated mount → also awaiting_approval
    assert.equal(f.gateway.registerIntent(ro(5, 'rooms', ['/bin/ls']), f.token).state, 'awaiting_approval');
    // exec.ro with cwd in the code mount → allow
    assert.equal(f.gateway.registerIntent(ro(6, 'code', ['/bin/ls']), f.token).state, 'executing');
  } finally { await f.close(); }
});

test('sandbox: excluded subtree is an EMPTY tmpfs inside bwrap; the rest of the mount is readable', { skip: !sandboxOk() && 'bwrap unavailable' }, async () => {
  const f = fixture(`    - {id: code, path: REPO, exclude: [rooms], residents: {resident_alpha_01: read-only}}
    - {id: rooms, path: REPO/rooms, gate: approve, residents: {resident_alpha_01: read-only}}`);
  try {
    f.gateway.registerIntent(ro(7, 'code', ['/bin/sh', '-lc', 'cat packages/code.js; echo ---; ls rooms; echo "rooms_entries=$(ls rooms | wc -l)"; cat rooms/乙/SECRET.md 2>&1 || true']), f.token);
    await until(() => f.gateway.getIntent('req_gatero007', f.token).state !== 'executing');
    const out = f.gateway.readOutput('req_gatero007', f.token, 'sub_g1').result.details.stdout;
    assert.match(out, /recall\(1\);/, 'code is readable');
    assert.match(out, /rooms_entries=0/, 'rooms/ exists but is empty inside the sandbox');
    assert.doesNotMatch(out, /beta-private/, 'other room content never visible');
  } finally { await f.close(); }
});

test('gate only tightens: a gated mount cannot turn approve into allow', async () => {
  const f = fixture(`    - {id: rooms, path: REPO/rooms, gate: approve, residents: {resident_alpha_01: read-only}}`);
  try {
    assert.equal(f.gateway.effectivePermission('core.fs.write', 'resident_alpha_01', f.gateway.policy, ['rooms']), 'approve');
    assert.equal(f.gateway.effectivePermission('core.fs.read', 'resident_alpha_01', f.gateway.policy, ['rooms']), 'approve');
    assert.equal(f.gateway.effectivePermission('core.fs.read', 'resident_alpha_01', f.gateway.policy, ['own-room']), 'allow', 'own-room untouched');
  } finally { await f.close(); }
});

// ---------- 审查员 rereview P1: exclude must fail closed ----------
test('P1 exclude → file: refused at registration, no auto-read', async () => {
  const f = fixture(`    - {id: code, path: REPO, exclude: [docs/note.md], residents: {resident_alpha_01: read-only}}`);
  try {
    assert.throws(() => f.gateway.registerIntent(ro(20, 'code', ['/bin/cat', 'docs/note.md']), f.token), e => e.code === 'GW-SANDBOX-DENIED' && /非链接目录/.test(e.message));
    assert.throws(() => f.gateway.registerIntent(rd(20, 'code', 'packages/code.js'), f.token), e => e.code === 'GW-SANDBOX-DENIED', 'even an unrelated read is refused: the mount config is invalid');
  } finally { await f.close(); }
});

test('P1 exclude → missing path: refused at registration', async () => {
  const f = fixture(`    - {id: code, path: REPO, exclude: [does-not-exist], residents: {resident_alpha_01: read-only}}`);
  try { assert.throws(() => f.gateway.registerIntent(ro(21, 'code', ['/bin/true']), f.token), e => e.code === 'GW-SANDBOX-DENIED' && /不存在/.test(e.message)); }
  finally { await f.close(); }
});

test('P1 exclude → symlink to a directory: refused', async () => {
  const f = fixture(`    - {id: code, path: REPO, exclude: [link], residents: {resident_alpha_01: read-only}}`);
  try {
    fs.symlinkSync(path.join(f.root, 'rooms'), path.join(f.root, 'link'));
    assert.throws(() => f.gateway.registerIntent(ro(22, 'code', ['/bin/true']), f.token), e => e.code === 'GW-SANDBOX-DENIED');
  } finally { await f.close(); }
});

test('P1 exclude dir replaced by a FILE between registration and spawn: execution refused, nothing runs', { skip: !sandboxOk() && 'bwrap unavailable' }, async () => {
  const f = fixture(`    - {id: code, path: REPO, exclude: [rooms], residents: {resident_alpha_01: read-only}}`);
  const marker = path.join(f.root, 'packages', 'RAN');
  const i23 = ro(23, 'code', ['/bin/sh', '-lc', 'cat rooms/乙/SECRET.md; touch packages/RAN']);
  try {
    process.env.SAMEROOF_GATEWAY_FAULT_BEFORE_SPAWN = path.join(f.root, 'fault');
    // register (allow → executing, queued); the fault window pauses execShell before spawn
    f.gateway.registerIntent(i23, f.token);
    await until(() => fs.existsSync(path.join(f.root, 'fault')), 5000);
    // swap the excluded directory for a file while paused
    fs.rmSync(path.join(f.root, 'rooms'), { recursive: true, force: true }); fs.writeFileSync(path.join(f.root, 'rooms'), 'now-a-file\n');
  } finally { delete process.env.SAMEROOF_GATEWAY_FAULT_BEFORE_SPAWN; }
  try {
    // the fault window is 30s; we can't shorten it from here, so drive the check directly: the mount-assembly re-check must throw
    const row = f.gateway.state.db.prepare('SELECT * FROM intents WHERE request_id=?').get(i23.request_id);
    await assert.rejects(f.gateway.execShell('resident_alpha_01', { ...JSON.parse(row.params_json), writable_root_ids: [] }, f.gateway.policy), e => e.code === 'GW-SANDBOX-DENIED' && /exclude/.test(e.message));
    assert.equal(fs.existsSync(marker), false, 'sandbox never ran');
  } finally {
    // restore a directory so fixture cleanup and the paused executor don't explode; then close
    try { fs.rmSync(path.join(f.root, 'rooms'), { force: true }); fs.mkdirSync(path.join(f.root, 'rooms', '甲'), { recursive: true }); } catch {}
    await f.close();
  }
});

// ---------- 审查员 rereview P2: legacy rows + policy-tightened reads ----------
test('P2 legacy output_json rows without a retention snapshot are cleared at startup', async () => {
  const f = fixture(`    - {id: code, path: REPO, exclude: [rooms], residents: {resident_alpha_01: read-only}}`);
  try {
    const i30 = rd(30, 'code', 'docs/note.md'); f.gateway.registerIntent(i30, f.token);
    await until(() => f.gateway.getIntent(i30.request_id, f.token).state !== 'executing');
    // simulate a row written by the pre-snapshot version
    f.gateway.state.db.prepare('UPDATE intents SET output_expires_at=NULL, output_max_reads=NULL WHERE request_id=?').run(i30.request_id);
    await f.gateway.close();
    const { createGateway } = require('../server');
    const gw2 = createGateway({ houseDir: f.root, runDir: path.join(f.root, 'run'), stateDir: path.join(f.root, 'state'), lockRequired: false, resultClient: async () => ({ message_id: 'm' }) });
    try {
      assert.equal(gw2.legacyOutputsCleared, 1);
      assert.equal(gw2.state.db.prepare('SELECT output_json FROM intents WHERE request_id=?').get(i30.request_id).output_json, null);
      assert.ok(gw2.state.db.prepare("SELECT count(*) c FROM audit WHERE request_id=? AND event='output_cleared' AND status='legacy_no_snapshot'").get(i30.request_id).c === 1);
      assert.throws(() => gw2.readOutput(i30.request_id, f.token, 'sub_g1'), e => /GW-OUTPUT-(CONSUMED|EXPIRED)/.test(e.code));
    } finally { await gw2.close(); }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('P2 policy tightens reads below the row cap: 410 clears output_json; sweep also honours the tighter cap', async () => {
  const f = fixture(`    - {id: code, path: REPO, exclude: [rooms], residents: {resident_alpha_01: read-only}}`);
  try {
    const i31 = rd(31, 'code', 'docs/note.md'); f.gateway.registerIntent(i31, f.token);
    await until(() => f.gateway.getIntent(i31.request_id, f.token).state !== 'executing');
    assert.equal(f.gateway.state.db.prepare('SELECT output_max_reads FROM intents WHERE request_id=?').get(i31.request_id).output_max_reads, 3, 'row cap 3');
    f.gateway.readOutput(i31.request_id, f.token, 'sub_g1');   // 1 read
    f.gateway.policy.house.gateway.output_max_reads = 1;         // policy tightened to 1
    assert.throws(() => f.gateway.readOutput(i31.request_id, f.token, 'sub_g1'), e => e.code === 'GW-OUTPUT-CONSUMED');
    assert.equal(f.gateway.state.db.prepare('SELECT output_json FROM intents WHERE request_id=?').get(i31.request_id).output_json, null, 'cleared on the failing read, not retained until ttl');
    // sweep path: a second row, 1 read done, policy 1 → sweep clears it without any read attempt
    f.gateway.policy.house.gateway.output_max_reads = 3;
    const i32 = rd(32, 'code', 'docs/note.md'); f.gateway.registerIntent(i32, f.token);
    await until(() => f.gateway.getIntent(i32.request_id, f.token).state !== 'executing');
    f.gateway.readOutput(i32.request_id, f.token, 'sub_g1');
    f.gateway.policy.house.gateway.output_max_reads = 1;
    assert.ok(f.gateway.sweepOutput() >= 1);
    assert.equal(f.gateway.state.db.prepare('SELECT output_json FROM intents WHERE request_id=?').get(i32.request_id).output_json, null);
  } finally { await f.close(); }
});
