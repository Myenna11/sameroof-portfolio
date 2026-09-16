'use strict';
// serve shutdown must actually get rid of children — including one that ignores SIGTERM.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { stopChildren } = require('../house');

const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const spawnNode = code => spawn(process.execPath, ['-e', code + "; process.stdout.write('READY\\n')"], { stdio: ['ignore', 'pipe', 'ignore'] });
// wait until the child has installed its handlers (under CPU contention a fixed sleep is not enough — the default SIGTERM would kill it first)
const ready = c => new Promise(r => { let s = ''; c.stdout.on('data', d => { s += d; if (s.includes('READY')) r(); }); });

test('cooperative child: SIGTERM is enough, no SIGKILL sent', async () => {
  const c = spawnNode('setInterval(() => {}, 1000)');
  await ready(c);
  const r = await stopChildren([c], { graceMs: 2000 });
  assert.deepEqual(r.killed, [], 'not escalated');
  assert.deepEqual(r.stillAlive, []);
  assert.equal(pidAlive(c.pid), false, 'pid gone');
});

test('stubborn child ignores SIGTERM: escalates to SIGKILL and confirms the pid is gone', async () => {
  const c = spawnNode("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
  await ready(c);
  // Demonstrate the trap the old code fell into:
  c.kill('SIGTERM'); await new Promise(r => setTimeout(r, 200));
  assert.equal(c.killed, true, 'child.killed is true after kill() was called…');
  assert.equal(pidAlive(c.pid), true, '…but the process is still alive');

  const r = await stopChildren([c], { graceMs: 500 });
  assert.deepEqual(r.killed, [c.pid], 'escalated to SIGKILL');
  assert.deepEqual(r.stillAlive, []);
  assert.equal(pidAlive(c.pid), false, 'pid gone after SIGKILL');
});

test('mixed batch: only the stubborn one is escalated', async () => {
  const good = spawnNode('setInterval(() => {}, 1000)');
  const bad = spawnNode("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
  await Promise.all([ready(good), ready(bad)]);
  const r = await stopChildren([good, bad], { graceMs: 500 });
  assert.deepEqual(r.killed, [bad.pid]);
  assert.deepEqual(r.stillAlive, []);
  assert.equal(pidAlive(good.pid), false);
  assert.equal(pidAlive(bad.pid), false);
});

// Regression for CI #15-17: serve referenced an undefined `house` when computing token purposes → "serve failed: house is not defined".
// serve is process-level; the cheapest guard is a load-time symbol check on the function body.
test('serve does not reference an undefined `house` symbol', () => {
  const src = require('node:fs').readFileSync(require.resolve('../house.js'), 'utf8');
  const serveBody = src.slice(src.indexOf('  serve(args, opts) {'), src.indexOf('  /** sameroof cred add'));
  assert.ok(serveBody.includes('const houseDoc = loadYaml('), 'serve loads house.yaml into houseDoc');
  assert.ok(!/[^a-zA-Z_.]house\.defaults/.test(serveBody), 'no bare `house.defaults` in serve');
});
