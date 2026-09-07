'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { generateLock, writeLock, verifyLock, LockError } = require('../lock');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-lock-'));
  fs.mkdirSync(path.join(root, 'rooms', '甲'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages', 'schema'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages', 'adapters', 'pi'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages', 'living-room'), { recursive: true });
  for (const name of ['house.schema.json', 'room.schema.json']) {
    fs.copyFileSync(path.join(__dirname, '..', '..', 'schema', name), path.join(root, 'packages', 'schema', name));
  }
  fs.writeFileSync(path.join(root, 'packages', 'adapters', 'pi', 'adapter.js'), 'module.exports = {}\n');
  fs.writeFileSync(path.join(root, 'packages', 'living-room', 'server.js'), 'module.exports = {}\n');
  fs.writeFileSync(path.join(root, 'packages', 'living-room', 'package.json'), '{"version":"1.2.3"}\n');
  fs.writeFileSync(path.join(root, 'house.yaml'), `schema_version: 1
name: 测试小家
timezone: Asia/Shanghai
defaults:
  runtime: pi
  plugins: [living-room]
  heartbeat: {enabled: true, mode: minimal, interval: adaptive, budget: {per_day: {requests: 12, tokens: 50000}, on_exceeded: passive}}
  context: {recent_messages: 20, recent_max_chars: 4000, memory_hits: 4, memory_recent: 3}
  approve_timeout: 30m
  permissions: {living_room.send: allow}
credentials:
  - {alias: shared-cheap, provider: zhipu, purpose: 测试}
notify: {admin: 甲}
`);
  fs.writeFileSync(path.join(root, 'rooms', '甲', 'room.yaml'), `schema_version: 1
id: resident_alpha_01
name: 甲
species: agent
model: {provider: zhipu, id: glm-test, auth: {mode: broker, credential: shared-cheap}}
runtime: pi
plugins: [living-room]
permissions: {living_room.send: allow}
`);
  return root;
}

test('lock is deterministic, secret-free, and records concrete component digests', () => {
  const root = fixture();
  try {
    const first = generateLock(root);
    const second = generateLock(root);
    assert.deepEqual(first, second);
    assert.equal(first.lock_version, 1);
    assert.equal(first.components.runtimes[0].id, 'pi');
    assert.equal(first.components.plugins[0].version, '1.2.3');
    assert.deepEqual(first.credentials, [{ alias: 'shared-cheap', provider: 'zhipu', mode: 'broker' }]);
    assert.equal(JSON.stringify(first).includes('api_key'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('write is atomic and check fails closed after config or component drift', () => {
  const root = fixture();
  try {
    writeLock(root);
    assert.equal(verifyLock(root).lock_version, 1);
    fs.appendFileSync(path.join(root, 'packages', 'adapters', 'pi', 'adapter.js'), '// drift\n');
    assert.throws(() => verifyLock(root), error => error instanceof LockError && error.code === 'LOCK-STALE-001');
    writeLock(root);
    fs.appendFileSync(path.join(root, 'rooms', '甲', 'room.yaml'), '\n# intent drift\n');
    assert.throws(() => verifyLock(root), error => error instanceof LockError && error.code === 'LOCK-STALE-001');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
