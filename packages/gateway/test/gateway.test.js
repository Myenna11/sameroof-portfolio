'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const test = require('node:test');
const { createGateway, GatewayError, normalizeRelative, protectedPath, assertUnprivileged, FS_READ_MAX } = require('../server');

const HOUSE = `schema_version: 1
name: gateway-test
timezone: UTC
defaults:
  runtime: test
  plugins: []
  heartbeat: {}
  context: {recent_messages: 0, recent_max_chars: 0, memory_hits: 0, memory_recent: 0}
  approve_timeout: 1m
  permissions:
    core.fs.read: approve
    core.fs.write: approve
    core.exec: approve
credentials: []
notify: {admin: 甲}
`;

function roomYaml(id, name, permissions = '') { return `schema_version: 1\nid: ${id}\nname: ${name}\nspecies: human\n${permissions}`; }
function writeLock(root) {
  const names = ['house.yaml', 'rooms/乙/room.yaml', 'rooms/甲/room.yaml'].sort((a, b) => a.localeCompare(b)); const files = {}; const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  for (const name of names) files[name] = digest(fs.readFileSync(path.join(root, name)));
  const sourceDigest = digest(names.map(name => name + '\0' + files[name] + '\n').join(''));
  fs.writeFileSync(path.join(root, 'house.lock'), JSON.stringify({ source: { algorithm: 'sha256', files, digest: sourceDigest } }));
  return sourceDigest;
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-gateway-'));
  for (const [name, id] of [['甲', 'resident_alpha_01'], ['乙', 'resident_beta_01']]) {
    fs.mkdirSync(path.join(root, 'rooms', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'rooms', name, 'room.yaml'), roomYaml(id, name));
  }
  fs.writeFileSync(path.join(root, 'house.yaml'), HOUSE);
  const delivered = [];
  const gateway = createGateway({ houseDir: root, runDir: path.join(root, 'run'), stateDir: path.join(root, 'state'), bwrapProbe: false, lockRequired: false, resultClient: async value => delivered.push(value), ...options });
  const issued = gateway.issueAdapterToken('resident_alpha_01');
  return { root, gateway, token: issued.token, delivered, close: async () => { await gateway.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

function writeIntent(overrides = {}) {
  return { request_id: 'req_12345678', resident_id: 'resident_alpha_01', run_id: 'run_12345678', action: 'core.fs.write', params: { root_id: 'own-room', path: 'note.md', content: 'hello', mode: 'create' }, requested_ttl_seconds: 60, ...overrides };
}
function approval(intent, extra = {}) { return { approval_id: 'apr_12345678', gateway_request_id: intent.request_id, resident_id: intent.resident_id, action: intent.action, params_digest: require('@sameroof/jcs').digest(intent.params), decision: 'allowed', single_use: true, expires_at: new Date(Date.now() + 60000).toISOString(), ...extra }; }
function request(socketPath, pathname, options = {}) { return new Promise((resolve, reject) => { const data = options.body ? JSON.stringify(options.body) : ''; const req = http.request({ socketPath, path: pathname, method: options.method || 'GET', headers: { ...(options.token ? { authorization: 'Bearer ' + options.token } : {}), ...(options.key ? { 'idempotency-key': options.key } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })); }); req.on('error', reject); req.end(data); }); }

test('path grammar and hard protected names fail closed', () => {
  assert.equal(normalizeRelative('a/b.md'), 'a/b.md');
  for (const p of ['../a', '/tmp/a', 'a//b', 'a\\b', './a']) assert.throws(() => normalizeRelative(p), /路径/);
  for (const p of ['.env', '.env.local', '.envrc', 'prod.env', 'nested/release.env', '.git/hooks/x', '.git/config', 'house.yaml', 'room.yaml', 'rooms/甲/room.yaml', 'x/.sameroof/y']) assert.equal(protectedPath(p), true, p);
});

test('intent idempotency, direct write, approval one-shot and redacted persistence', async () => {
  const f = fixture();
  try {
    const intent = writeIntent();
    const first = f.gateway.registerIntent(intent, f.token);
    assert.equal(first.state, 'awaiting_approval');
    assert.deepEqual(f.gateway.registerIntent(intent, f.token), first);
    assert.throws(() => f.gateway.registerIntent(writeIntent({ params: { ...intent.params, content: 'different' } }), f.token), e => e.code === 'GW-IDEMPOTENCY-CONFLICT');
    const result = await f.gateway.execute(intent.request_id, approval(intent));
    assert.equal(result.status, 'succeeded');
    assert.equal(fs.readFileSync(path.join(f.root, 'rooms', '甲', 'note.md'), 'utf8'), 'hello');
    assert.equal(f.delivered.length, 1);
    await assert.rejects(f.gateway.execute(intent.request_id, approval(intent)), e => e.code === 'GW-APPROVAL-MISMATCH' || e.code === 'GW-APPROVAL-USED');
    const audit = f.gateway.state.db.prepare('SELECT event FROM audit WHERE request_id=? ORDER BY id').all(intent.request_id).map(x => x.event);
    assert.deepEqual(audit.slice(0, 3), ['asked', 'decided', 'executed']);
  } finally { await f.close(); }
});

test('symlink, other room and bwrap probe failure never execute', async () => {
  const f = fixture();
  try {
    fs.symlinkSync('/tmp', path.join(f.root, 'rooms', '甲', 'link'));
    assert.throws(() => f.gateway.registerIntent(writeIntent({ request_id: 'req_symlink1', params: { root_id: 'own-room', path: 'link/x', content: 'x', mode: 'create' } }), f.token), e => e.code === 'GW-PATH-SYMLINK');
    const execIntent = { request_id: 'req_exec0001', resident_id: 'resident_alpha_01', action: 'core.exec', params: { argv: ['/bin/sh', '-lc', 'touch should-not-exist'], cwd: { root_id: 'own-room', path: '' }, writable_root_ids: ['own-room'], timeout_ms: 1000 } };
    f.gateway.registerIntent(execIntent, f.token);
    const result = await f.gateway.execute(execIntent.request_id, approval(execIntent, { approval_id: 'apr_exec0001' }));
    assert.equal(result.status, 'denied');
    assert.equal(result.error.code, 'GW-SANDBOX-UNAVAILABLE');
    assert.equal(fs.existsSync(path.join(f.root, 'rooms', '甲', 'should-not-exist')), false);
  } finally { await f.close(); }
});

test('approval replay cannot authorize another request', async () => {
  const f = fixture();
  try {
    const a = writeIntent({ request_id: 'req_replay01' });
    const b = writeIntent({ request_id: 'req_replay02', params: { root_id: 'own-room', path: 'two.md', content: 'two', mode: 'create' } });
    f.gateway.registerIntent(a, f.token); f.gateway.registerIntent(b, f.token);
    await f.gateway.execute(a.request_id, approval(a, { approval_id: 'apr_same0001' }));
    await assert.rejects(f.gateway.execute(b.request_id, approval(b, { approval_id: 'apr_same0001' })), e => e instanceof GatewayError && e.code === 'GW-APPROVAL-USED');
    assert.equal(fs.existsSync(path.join(f.root, 'rooms', '甲', 'two.md')), false);
  } finally { await f.close(); }
});

test('HTTP Unix socket requires matching Idempotency-Key and GET never echoes params', async () => {
  const f = fixture();
  try {
    await f.gateway.listen(); const intent = writeIntent({ request_id: 'req_http0001' });
    assert.equal((await request(f.gateway.socketPath, '/v1/intents', { method: 'POST', token: f.token, body: intent })).body.error.code, 'GW-IDEMPOTENCY-CONFLICT');
    assert.equal((await request(f.gateway.socketPath, '/v1/intents', { method: 'POST', token: f.token, key: intent.request_id, body: intent })).status, 200);
    const got = await request(f.gateway.socketPath, '/v1/intents/' + intent.request_id, { token: f.token });
    assert.equal(got.status, 200); assert.equal(got.body.state, 'awaiting_approval'); assert.equal(Object.hasOwn(got.body, 'params'), false);
  } finally { await f.close(); }
});

test('house.lock drift rejects a new intent before it is recorded', async () => {
  const f = fixture({ lockRequired: true });
  try {
    writeLock(f.root);
    assert.equal(f.gateway.registerIntent(writeIntent({ request_id: 'req_locked01' }), f.token).state, 'awaiting_approval');
    fs.appendFileSync(path.join(f.root, 'house.yaml'), '# drift\n');
    assert.throws(() => f.gateway.registerIntent(writeIntent({ request_id: 'req_locked02' }), f.token), e => e.code === 'GW-POLICY-DENIED');
    fs.writeFileSync(path.join(f.root, 'house.yaml'), HOUSE); fs.mkdirSync(path.join(f.root, 'rooms', '丙')); fs.writeFileSync(path.join(f.root, 'rooms', '丙', 'room.yaml'), roomYaml('resident_gamma_01', '丙'));
    assert.throws(() => f.gateway.registerIntent(writeIntent({ request_id: 'req_locked03' }), f.token), e => e.code === 'GW-POLICY-DENIED');
  } finally { await f.close(); }
});

test('verified policy digest reloads atomically while an old intent keeps its registered snapshot', async () => {
  const f = fixture({ lockRequired: true });
  try {
    const oldDigest = writeLock(f.root); const old = writeIntent({ request_id: 'req_policy01', params: { root_id: 'own-room', path: 'old.md', content: 'old policy', mode: 'create' } });
    const registered = f.gateway.registerIntent(old, f.token); assert.equal(registered.policy_digest, oldDigest);
    fs.writeFileSync(path.join(f.root, 'rooms', '甲', 'room.yaml'), roomYaml('resident_alpha_01', '甲', 'permissions:\n  core.fs.write: deny\n'));
    const newDigest = writeLock(f.root); assert.notEqual(newDigest, oldDigest);
    assert.throws(() => f.gateway.registerIntent(writeIntent({ request_id: 'req_policy02', params: { root_id: 'own-room', path: 'new.md', content: 'new policy', mode: 'create' } }), f.token), e => e.code === 'GW-POLICY-DENIED');
    assert.equal(f.gateway.policy.digest, newDigest);
    const result = await f.gateway.execute(old.request_id, approval(old, { approval_id: 'apr_policy01' }));
    assert.equal(result.status, 'succeeded'); assert.equal(fs.readFileSync(path.join(f.root, 'rooms', '甲', 'old.md'), 'utf8'), 'old policy');
  } finally { await f.close(); }
});

test('file read transport is usable at the documented limit and rejects larger requests', async () => {
  const f = fixture();
  try {
    const content = 'x'.repeat(FS_READ_MAX - 1); fs.writeFileSync(path.join(f.root, 'rooms', '甲', 'near-limit.txt'), content);
    const intent = { request_id: 'req_readlimit', resident_id: 'resident_alpha_01', action: 'core.fs.read', params: { root_id: 'own-room', path: 'near-limit.txt', max_bytes: FS_READ_MAX } };
    f.gateway.registerIntent(intent, f.token); const result = await f.gateway.execute(intent.request_id, approval(intent, { approval_id: 'apr_readlimit' }));
    assert.equal(result.status, 'succeeded'); assert.equal(result.details.content, content); assert.match(result.summary, new RegExp('x{100}'));
    assert.throws(() => f.gateway.registerIntent({ ...intent, request_id: 'req_readlarge', params: { ...intent.params, max_bytes: FS_READ_MAX + 1 } }, f.token), e => e.code === 'GW-PARAMS-INVALID');
  } finally { await f.close(); }
});

test('production entry refuses root and the unit has a narrow writable allowlist', () => {
  assert.throws(() => assertUnprivileged(0), e => e.code === 'GW-ROOT-FORBIDDEN'); assert.equal(assertUnprivileged(65534), true);
  const candidates = [path.resolve(__dirname, '../../../deploy/sameroof-gateway.service'), path.resolve(__dirname, '../../sameroof-gateway.service')];
  const unit = fs.readFileSync(candidates.find(fs.existsSync), 'utf8');
  assert.match(unit, /^User=sameroof-gateway$/m); assert.match(unit, /^Group=sameroof$/m); assert.match(unit, /^UMask=0077$/m);
  assert.match(unit, /^ReadWritePaths=\/srv\/sameroof\/rooms$/m); assert.doesNotMatch(unit, /^ReadWritePaths=\/srv\/sameroof$/m);
  assert.match(unit, /^ReadOnlyPaths=\/srv\/sameroof\/house\.yaml \/srv\/sameroof\/house\.lock$/m);
  assert.match(unit, /additional project mounts require a systemd drop-in/i);
});

test('known tokens are redacted from file results and persisted result', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'rooms', '甲', 'secret.txt'), 'before ' + f.token + ' after');
    const intent = { request_id: 'req_read0001', resident_id: 'resident_alpha_01', action: 'core.fs.read', params: { root_id: 'own-room', path: 'secret.txt' } };
    f.gateway.registerIntent(intent, f.token); const result = await f.gateway.execute(intent.request_id, approval(intent, { approval_id: 'apr_read0001' }));
    assert.doesNotMatch(result.details.content, new RegExp(f.token)); assert.match(result.details.content, /已脱敏/);
    assert.doesNotMatch(f.gateway.state.db.prepare('SELECT result_json FROM intents WHERE request_id=?').get(intent.request_id).result_json, new RegExp(f.token));
  } finally { await f.close(); }
});

test('exec timeout waits for process death and spawn failure stays fail-closed', async () => {
  const sleeper = path.join(os.tmpdir(), 'fake-bwrap-' + process.pid + '-' + Date.now()); fs.writeFileSync(sleeper, '#!/bin/sh\ntrap "" TERM\nsleep 5\n', { mode: 0o755 });
  const f = fixture({ bwrapPath: sleeper, bwrapProbe: () => true });
  try {
    const intent = { request_id: 'req_timeout1', resident_id: 'resident_alpha_01', action: 'core.exec', params: { argv: ['/bin/true'], cwd: { root_id: 'own-room', path: '' }, writable_root_ids: [], timeout_ms: 50 } };
    f.gateway.registerIntent(intent, f.token); const result = await f.gateway.execute(intent.request_id, approval(intent, { approval_id: 'apr_timeout1' })); assert.equal(result.status, 'timed_out');
  } finally { await f.close(); fs.rmSync(sleeper, { force: true }); }
  const broken = fixture({ bwrapPath: '/definitely/missing/bwrap', bwrapProbe: () => true });
  try { const intent = { request_id: 'req_spawnbad', resident_id: 'resident_alpha_01', action: 'core.exec', params: { argv: ['/bin/true'], cwd: { root_id: 'own-room', path: '' }, writable_root_ids: [], timeout_ms: 100 } }; broken.gateway.registerIntent(intent, broken.token); const result = await broken.gateway.execute(intent.request_id, approval(intent, { approval_id: 'apr_spawnbad' })); assert.equal(result.status, 'denied'); assert.equal(result.error.code, 'GW-SANDBOX-UNAVAILABLE'); }
  finally { await broken.close(); }
});
