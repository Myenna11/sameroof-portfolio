'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const CLI = path.resolve(__dirname, '../index.js');
const linux = process.platform === 'linux';
const root = process.getuid?.() === 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await sleep(50); }
  throw new Error('Timed out: ' + label);
}
function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-serve-'));
  const home = path.join(tmp, 'home'), ws = path.join(tmp, 'ws'); fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, SAMEROOF_ROOT: ws, SAMEROOF_ENABLE_MOCK: '1', SAMEROOF_CI_MOCK_ONLY: '1' };
  // Do not borrow sockets or token paths from a developer's environment.
  for (const k of Object.keys(env)) if (/^SAMEROOF_(BROKER|GATEWAY|LIVING_ROOM|LR|DATA|RUN)/.test(k)) delete env[k];
  execFileSync(process.execPath, [CLI, 'init', ws], { env, stdio: 'pipe' });
  execFileSync(process.execPath, [CLI, 'new', 'me', '--human', '--house', ws], { env, stdio: 'pipe' });
  execFileSync(process.execPath, [CLI, 'lock', '--house', ws], { env, stdio: 'pipe' });
  const started = [];
  const start = args => {
    const child = spawn(process.execPath, [CLI, 'serve', '--house', ws, '--port', '0', '--no-agents', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const state = { child, log: '', exited: false, code: null };
    child.stdout.on('data', b => state.log += b); child.stderr.on('data', b => state.log += b);
    child.on('exit', code => { state.exited = true; state.code = code; }); started.push(state); return state;
  };
  t.after(async () => {
    for (const s of started) if (!s.exited) { s.child.kill('SIGTERM'); await until(() => s.exited, 'cleanup', 22000).catch(() => s.child.kill('SIGKILL')); }
    if (path.dirname(tmp) === os.tmpdir() && path.basename(tmp).startsWith('sr-serve-')) fs.rmSync(tmp, { recursive: true, force: true });
  });
  return { home, ws, env, start };
}
const gatewayFlags = ['--with-gateway', ...(root ? ['--gateway-allow-root'] : [])];
async function ready(s) { await until(() => { if (s.exited) throw new Error(s.log); return s.log.includes('Same Roof running:'); }, 'serve ready'); }
function gone(pid) { try { process.kill(Number(pid), 0); return false; } catch (e) { if (e.code === 'ESRCH') return true; throw e; } }
function childPids(s) { return [...s.log.matchAll(/\(pid (\d+)[);]/g)].map(m => Number(m[1])); }

test('invalid web port fails before opening runtime state', { skip: !linux }, async t => {
  const f = fixture(t), s = f.start(['--web', 'oops']);
  await until(() => s.exited, 'invalid port exit'); assert.notEqual(s.code, 0);
  assert.match(s.log, /Invalid web port/); assert(!fs.existsSync(path.join(f.home, '.sameroof', 'run', 'serve.lock')));
});

test('gateway root denial happens before broker or token creation', { skip: !linux || !root }, async t => {
  const f = fixture(t), s = f.start(['--with-gateway']);
  await until(() => s.exited, 'root rejection'); assert.notEqual(s.code, 0); assert.match(s.log, /refuses to run as root/);
  assert(!fs.existsSync(path.join(f.home, '.sameroof')));
});

test('gateway + web bind ephemeral ports, proxy auth, then all children exit', { skip: !linux, timeout: 45000 }, async t => {
  const f = fixture(t), s = f.start([...gatewayFlags, '--web', '0']); await ready(s);
  const port = s.log.match(/\[web\] http:\/\/127\.0\.0\.1:(\d+)/)[1]; assert.notEqual(port, '0');
  const token = JSON.parse(fs.readFileSync(path.join(f.home, '.sameroof/run/living-room-tokens.json'))).resident_me_01;
  const r = await fetch('http://127.0.0.1:' + port + '/api/me', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(3000) });
  assert.equal(r.status, 200); assert.equal((await r.json()).id, 'resident_me_01');
  const pids = childPids(s); assert.equal(pids.length, 2);
  s.child.kill('SIGINT'); await until(() => s.exited, 'shutdown'); assert.equal(s.code, 0);
  assert(pids.every(gone)); assert(!fs.existsSync(path.join(f.home, '.sameroof/run/serve.lock')));
});

test('occupied web port fails startup and cleans the already-started gateway', { skip: !linux, timeout: 45000 }, async t => {
  const occupied = net.createServer(); await new Promise(r => occupied.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => occupied.close(r)));
  const f = fixture(t), s = f.start([...gatewayFlags, '--web', String(occupied.address().port)]);
  await until(() => s.exited, 'failed startup shutdown'); assert.notEqual(s.code, 0);
  assert.match(s.log, /EADDRINUSE/); assert(!s.log.includes('Same Roof running:'));
  const pids = childPids(s); assert(pids.length >= 1); assert(pids.every(gone));
  assert(!fs.existsSync(path.join(f.home, '.sameroof/run/serve.lock')));
});

test('a failed infrastructure child shuts down the serve process and siblings', { skip: !linux, timeout: 45000 }, async t => {
  const f = fixture(t), s = f.start([...gatewayFlags, '--web', '0']); await ready(s);
  const pids = childPids(s), webPid = s.log.match(/\[web\].*\(pid (\d+)/)[1];
  process.kill(Number(webPid), 'SIGTERM'); await until(() => s.exited, 'infrastructure exit');
  assert.notEqual(s.code, 0); assert(pids.every(gone));
});

test('second serve sharing HOME is refused without replacing the first runtime', { skip: !linux, timeout: 45000 }, async t => {
  const f = fixture(t), a = f.start(['--web', '0']); await ready(a);
  const b = f.start(['--web', '0']); await until(() => b.exited, 'duplicate serve');
  assert.notEqual(b.code, 0); assert.match(b.log, /serve.lock exists/); assert.equal(a.exited, false);
  const port = a.log.match(/\[web\] http:\/\/127\.0\.0\.1:(\d+)/)[1];
  const r = await fetch('http://127.0.0.1:' + port + '/health'); assert.equal(r.status, 200); await r.arrayBuffer();
});

test('standalone live broker socket is never replaced by serve', { skip: !linux, timeout: 30000 }, async t => {
  const f = fixture(t), run = path.join(f.home, '.sameroof/run'); fs.mkdirSync(run, { recursive: true });
  const socketPath = path.join(run, 'broker.sock'), existing = net.createServer(c => c.end());
  await new Promise(r => existing.listen(socketPath, r)); t.after(() => new Promise(r => existing.close(r)));
  const inode = fs.statSync(socketPath).ino, s = f.start([]); await until(() => s.exited, 'occupied broker');
  assert.notEqual(s.code, 0); assert.match(s.log, /Another service already owns socket/); assert.equal(fs.statSync(socketPath).ino, inode);
});

test('the supplied quick-start example passes schema validation', t => {
  const f = fixture(t), dir = path.resolve(__dirname, '../../../examples/quick-start');
  execFileSync(process.execPath, [CLI, 'check', '--house', dir], { env: f.env, stdio: 'pipe' });
});
