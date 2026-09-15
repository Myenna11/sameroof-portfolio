'use strict';
// Design §4.2 / G4: a subrun's model call must not touch the resident's persistent shift.
// think() appends every turn to state/shift-<id>.jsonl; callOnce() must leave that file untouched
// and must send x-sameroof-purpose: subagent (+ x-sameroof-run) to the broker.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('callOnce: no shift write, purpose=subagent, run header; think: shift grows, purpose=interactive', async () => {
  // --- fake house on disk ---
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-callonce-'));
  const RUN = path.join(ROOT, '.sameroof', 'run');
  fs.mkdirSync(path.join(ROOT, 'rooms', 'bot'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'state'), { recursive: true });
  fs.mkdirSync(path.join(RUN, 'tokens'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(ROOT, 'house.yaml'), 'schema_version: 1\nname: T\ntimezone: UTC\ndefaults:\n  runtime: broker-direct\n  plugins: []\n  heartbeat: {enabled: false}\n  context: {recent_messages: 0, recent_max_chars: 0, memory_hits: 0, memory_recent: 0}\n  approve_timeout: 1m\n  permissions: {}\ncredentials:\n  - {alias: k, provider: mock, purpose: test}\nnotify: {admin: bot}\n');
  fs.writeFileSync(path.join(ROOT, 'rooms', 'bot', 'room.yaml'), 'schema_version: 1\nid: resident_bot_01\nname: bot\nspecies: agent\nmodel: {provider: mock, id: mock-chat, auth: {mode: broker, credential: k}}\nruntime: broker-direct\n');
  fs.writeFileSync(path.join(RUN, 'tokens', 'resident_bot_01'), 'sr_test_token\n');
  fs.writeFileSync(path.join(RUN, 'living-room-tokens.json'), JSON.stringify({ resident_bot_01: 'lr_test' }));

  // --- fake broker on the socket the adapter expects ---
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => {
      const body = JSON.parse(b);
      seen.push({ purpose: req.headers['x-sameroof-purpose'], run: req.headers['x-sameroof-run'], n: body.messages.length, last: body.messages[body.messages.length - 1].content });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'echo:' + body.messages[body.messages.length - 1].content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise(r => server.listen(path.join(RUN, 'broker.sock'), r));

  const saved = { HOME: process.env.HOME, SAMEROOF_ROOT: process.env.SAMEROOF_ROOT, argv: process.argv.slice() };
  process.env.HOME = ROOT; process.env.SAMEROOF_ROOT = ROOT; process.argv = [process.argv[0], 'adapter.js', 'bot'];
  delete require.cache[require.resolve('../broker-direct/adapter')];
  delete require.cache[require.resolve('../lib/room')];
  let adapter;
  try {
    adapter = require('../broker-direct/adapter');
    const shiftFile = adapter.shiftPath;
    const size = () => { try { return fs.statSync(shiftFile).size; } catch { return 0; } };

    // 1. callOnce: own messages, no shift growth
    const before = size();
    const r1 = await adapter.callOnce([{ role: 'system', content: 'sub' }, { role: 'user', content: 'grep this' }], null, { runId: 'sub_abc123' });
    assert.equal(r1.text, 'echo:grep this');
    assert.equal(size(), before, 'callOnce must not write the shift file');
    assert.equal(seen[0].purpose, 'subagent');
    assert.equal(seen[0].run, 'sub_abc123');
    assert.equal(seen[0].n, 2, 'exactly the caller-supplied messages');

    // 2. think: appends to shift, purpose interactive, no run header
    const r2 = await adapter.think('sys', 'hello');
    assert.match(r2.text || String(r2), /echo:/);
    assert.ok(size() > before, 'think must append to the shift file');
    assert.equal(seen[1].purpose, 'interactive');
    assert.equal(seen[1].run, undefined);

    // 3. callOnce again: still no shift growth, and it did NOT see think's history
    const afterThink = size();
    const r3 = await adapter.callOnce([{ role: 'user', content: 'again' }], null);
    assert.equal(r3.text, 'echo:again');
    assert.equal(size(), afterThink);
    assert.equal(seen[2].n, 1, 'callOnce does not carry the resident shift');
  } finally {
    await new Promise(r => server.close(r));
    process.env.HOME = saved.HOME; process.env.SAMEROOF_ROOT = saved.SAMEROOF_ROOT; process.argv = saved.argv;
    try { if (adapter && adapter.shift && adapter.shift.close) adapter.shift.close(); } catch {}
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
});
