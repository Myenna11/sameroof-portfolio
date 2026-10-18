'use strict';
// pi 房间一班一个会话：第一句开新会话，第二句起 --continue；交接信这类一次性调用 --no-session 不进会话；
// 隔太久没说话就归档换班。用一个假 pi（记下每次的参数）跑真的 adapter.think。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-pi-shift-'));
const BIN = path.join(ROOT, 'bin'), CALLS = path.join(ROOT, 'calls.jsonl');
const ENV_KEYS = ['HOME', 'SAMEROOF_ROOT', 'PATH'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(path.join(ROOT, 'rooms', '乙'), { recursive: true });
fs.mkdirSync(path.join(ROOT, '.sameroof', 'run'), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(ROOT, '.sameroof', 'run', 'living-room-tokens.json'), JSON.stringify({ resident_beta_01: 'lr-token' }));
fs.writeFileSync(path.join(ROOT, 'house.yaml'), 'schema_version: 1\nname: pi 会话测试\ntimezone: Asia/Manila\ndefaults:\n  runtime: pi\n  plugins: []\n  heartbeat: {enabled: false}\n');
fs.writeFileSync(path.join(ROOT, 'rooms', '乙', 'room.yaml'), 'schema_version: 1\nid: resident_beta_01\nname: 乙\nspecies: agent\nruntime: pi\nmodel: {provider: mock, id: m1, auth: {mode: runtime_managed}}\nheartbeat: {enabled: false}\n');
// 假 pi：记参数；带 --session-dir 时像真 pi 一样在会话目录里落一个会话文件
fs.writeFileSync(path.join(BIN, 'pi'), `#!/usr/bin/env node
const a = process.argv.slice(2), fs = require('fs'), path = require('path');
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(a) + '\\n');
const i = a.indexOf('--session-dir'); if (i >= 0) fs.writeFileSync(path.join(a[i + 1], 'session.jsonl'), 'x');
process.stdout.write('好');
`, { mode: 0o755 });
process.env.HOME = ROOT; process.env.SAMEROOF_ROOT = ROOT; process.env.PATH = BIN + path.delimiter + savedEnv.PATH;
process.argv[2] = '乙';
const { think, SHIFT_DIR } = require('../pi/adapter');

const calls = () => fs.readFileSync(CALLS, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const mode = a => a.includes('--no-session') ? 'oneshot' : a.includes('--continue') ? 'continue' : 'new';

test('pi 一班一个会话：新开 → 续接 → 交接信不进会话 → 隔太久换班', async () => {
  try {
    assert.equal(think.shift.turns(), 0);
    assert.equal(await think('S', '第一句'), '好');
    assert.equal(think.shift.turns(), 1);
    await think('S', '第二句');
    await think('S', '交接信', null, { oneShot: true });
    assert.equal(think.shift.turns(), 2, '一次性调用不算进这一班');
    const meta = JSON.parse(fs.readFileSync(path.join(SHIFT_DIR, 'shift.json'), 'utf8'));
    fs.writeFileSync(path.join(SHIFT_DIR, 'shift.json'), JSON.stringify({ ...meta, last: Date.now() - 4 * 3600e3 }));
    assert.equal(think.shift.turns(), 0, '隔 4 小时：归档换班');
    assert.ok(fs.readdirSync(path.join(path.dirname(SHIFT_DIR), 'shifts')).length === 1);
    await think('S', '新班第一句');
    assert.deepEqual(calls().map(mode), ['new', 'continue', 'oneshot', 'new']);
    assert.ok(calls().every(a => a.includes('--no-tools')));
  } finally {
    for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
});
