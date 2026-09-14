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
