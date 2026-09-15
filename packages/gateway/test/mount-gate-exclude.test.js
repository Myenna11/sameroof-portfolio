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
