'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { createAdapter } = require('../lib/core');

// Mini fake coordinator: just enough to test the adapter
function fakeCoordinator() {
  const messages = [];
  const sseClients = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': hi\n\n');
      sseClients.push(res);
      req.on('close', () => { const i = sseClients.indexOf(res); if (i >= 0) sseClients.splice(i, 1); });
      return;
    }
    if (req.url === '/say' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const msg = JSON.parse(body);
        messages.push(msg);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });

  return {
    server, messages,
    broadcast(msg) { for (const c of sseClients) c.write('data: ' + JSON.stringify(msg) + '\n\n'); },
    listen() { return new Promise(r => server.listen(0, () => r(server.address().port))); },
    close() { for (const c of sseClients) c.end(); return new Promise(r => server.close(r)); }
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('core adapter: receive message → think → respond', async () => {
  const coord = fakeCoordinator();
  const port = await coord.listen();
  const ctrl = new AbortController();
  const thinkCalls = [];

  const adapterP = createAdapter({
    coordinatorUrl: `http://127.0.0.1:${port}`,
    token: 'test-token',
    agentId: 'resident_test_01',
    agentName: 'test-agent',
    soul: 'You are a test agent.',
    think: async (system, user) => {
      thinkCalls.push({ system, user });
      return 'I received: ' + user;
    },
    signal: ctrl.signal
  });

  await sleep(300); // let SSE connect

  // Send a message mentioning our agent
  coord.broadcast({ kind: 'say', from_id: 'resident_human_01', text: 'hello @test-agent', mentions: ['resident_test_01'], seq: 1 });
  await sleep(500); // let it process

  assert.equal(thinkCalls.length, 1, 'think should be called once');
  assert.equal(thinkCalls[0].user, 'hello @test-agent');
  assert.ok(thinkCalls[0].system.includes('You are a test agent'));
  assert.equal(coord.messages.length, 1, 'should post one response');
  assert.equal(coord.messages[0].text, 'I received: hello @test-agent');

  ctrl.abort();
  await adapterP;
  await coord.close();
});

test('core adapter: skip messages not for me', async () => {
  const coord = fakeCoordinator();
  const port = await coord.listen();
  const ctrl = new AbortController();
  let thinkCount = 0;

  const adapterP = createAdapter({
    coordinatorUrl: `http://127.0.0.1:${port}`,
    token: 'test-token',
    agentId: 'resident_test_01',
    agentName: 'test-agent',
    soul: '',
    think: async () => { thinkCount++; return 'hi'; },
    signal: ctrl.signal
  });

  await sleep(300);

  // Message for someone else — should be ignored
  coord.broadcast({ kind: 'say', from_id: 'resident_human_01', text: 'hello @other-agent', mentions: ['resident_other_01'], seq: 1 });
  await sleep(300);
  assert.equal(thinkCount, 0, 'should not call think for unrelated message');

  ctrl.abort();
  await adapterP;
  await coord.close();
});

test('core adapter: silent response not posted', async () => {
  const coord = fakeCoordinator();
  const port = await coord.listen();
  const ctrl = new AbortController();

  const adapterP = createAdapter({
    coordinatorUrl: `http://127.0.0.1:${port}`,
    token: 'test-token',
    agentId: 'resident_test_01',
    agentName: 'test-agent',
    soul: '',
    think: async () => '(silent)',
    signal: ctrl.signal
  });

  await sleep(300);
  coord.broadcast({ kind: 'dm', from_id: 'resident_human_01', to_id: 'resident_test_01', text: 'hey', seq: 1 });
  await sleep(300);
  assert.equal(coord.messages.length, 0, 'silent response should not be posted');

  ctrl.abort();
  await adapterP;
  await coord.close();
});

test('core adapter: plugin hooks fire in order', async () => {
  const coord = fakeCoordinator();
  const port = await coord.listen();
  const ctrl = new AbortController();
  const log = [];

  const adapterP = createAdapter({
    coordinatorUrl: `http://127.0.0.1:${port}`,
    token: 'test-token',
    agentId: 'resident_test_01',
    agentName: 'test-agent',
    soul: 'base',
    think: async (system, user) => { log.push('think:' + system); return 'ok'; },
    plugins: [
      {
        name: 'plugin-a',
        async onWake() { log.push('wake-a'); },
        async beforeThink({ system, user }) { log.push('before-a'); return { system: system + '+a', user }; },
        async afterThink() { log.push('after-a'); },
        async onSleep() { log.push('sleep-a'); }
      },
      {
        name: 'plugin-b',
        async onWake() { log.push('wake-b'); },
        async beforeThink({ system, user }) { log.push('before-b'); return { system: system + '+b', user }; },
        async afterThink() { log.push('after-b'); },
        async onSleep() { log.push('sleep-b'); }
      }
    ],
    signal: ctrl.signal
  });

  await sleep(300);
  assert.deepEqual(log, ['wake-a', 'wake-b'], 'onWake fires in order');

  coord.broadcast({ kind: 'dm', from_id: 'resident_human_01', to_id: 'resident_test_01', text: 'go', seq: 1 });
  await sleep(500);

  assert.deepEqual(log, ['wake-a', 'wake-b', 'before-a', 'before-b', 'think:base+a+b', 'after-a', 'after-b']);

  ctrl.abort();
  await adapterP;
  await sleep(200);
  assert.deepEqual(log.slice(-2), ['sleep-a', 'sleep-b'], 'onSleep fires in order');

  await coord.close();
});

test('core adapter: think() is serialized — burst of 3 messages never overlaps', async () => {
  const coord = fakeCoordinator();
  const port = await coord.listen();
  const ctrl = new AbortController();
  let inFlight = 0, maxInFlight = 0, calls = 0;

  const adapterP = createAdapter({
    coordinatorUrl: `http://127.0.0.1:${port}`, token: 't', agentId: 'resident_test_01', agentName: 'test-agent', soul: '',
    think: async (s, u) => { calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await sleep(120); inFlight--; return 'r:' + u; },
    signal: ctrl.signal
  });
  await sleep(300);

  // Burst: 3 DMs back-to-back, faster than think() can process
  for (let i = 1; i <= 3; i++) coord.broadcast({ kind: 'dm', from_id: 'resident_human_01', to_id: 'resident_test_01', text: 'm' + i, seq: i });
  await sleep(700);

  assert.equal(calls, 3, 'all 3 processed');
  assert.equal(maxInFlight, 1, 'never more than 1 think() in flight');
  assert.deepEqual(coord.messages.map(m => m.text), ['r:m1', 'r:m2', 'r:m3'], 'responses in order');

  ctrl.abort(); await adapterP; await coord.close();
});

test('core adapter: throwing plugin is isolated — loop continues, other plugins run', async () => {
  const coord = fakeCoordinator();
  const port = await coord.listen();
  const ctrl = new AbortController();
  const log = [];
  const origErr = console.error; const errs = []; console.error = (...a) => errs.push(a.join(' '));

  const adapterP = createAdapter({
    coordinatorUrl: `http://127.0.0.1:${port}`, token: 't', agentId: 'resident_test_01', agentName: 'test-agent', soul: 'base',
    think: async (s) => { log.push('think:' + s); return 'ok'; },
    plugins: [
      { name: 'bad', async beforeThink() { throw new Error('boom'); } },
      { name: 'good', async beforeThink({ system, user }) { log.push('good-ran'); return { system: system + '+good', user }; } },
    ],
    signal: ctrl.signal
  });
  await sleep(300);
  coord.broadcast({ kind: 'dm', from_id: 'resident_human_01', to_id: 'resident_test_01', text: 'go', seq: 1 });
  await sleep(400);
  console.error = origErr;

  assert.deepEqual(log, ['good-ran', 'think:base+good'], 'good plugin ran, think ran with its contribution');
  assert.equal(coord.messages.length, 1, 'response still posted');
  assert.ok(errs.some(e => e.includes('plugin "bad".beforeThink failed: boom')), 'error was logged, not swallowed');

  ctrl.abort(); await adapterP; await coord.close();
});

test('core adapter: hanging plugin times out — loop continues', async () => {
  const coord = fakeCoordinator();
  const port = await coord.listen();
  const ctrl = new AbortController();
  const origErr = console.error; const errs = []; console.error = (...a) => errs.push(a.join(' '));

  const adapterP = createAdapter({
    coordinatorUrl: `http://127.0.0.1:${port}`, token: 't', agentId: 'resident_test_01', agentName: 'test-agent', soul: '',
    think: async () => 'ok', pluginTimeoutMs: 150,
    plugins: [{ name: 'hang', beforeThink: () => new Promise(() => {}) }],
    signal: ctrl.signal
  });
  await sleep(300);
  coord.broadcast({ kind: 'dm', from_id: 'resident_human_01', to_id: 'resident_test_01', text: 'go', seq: 1 });
  await sleep(500);
  console.error = origErr;

  assert.equal(coord.messages.length, 1, 'response posted despite hanging plugin');
  assert.ok(errs.some(e => e.includes('timed out')), 'timeout logged');

  ctrl.abort(); await adapterP; await coord.close();
});
