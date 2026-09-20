'use strict';
// Real adapter processes + real coordinator + a fault-injecting HTTP transport.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { createLivingRoom } = require('@sameroof/living-room/server');

for (const route of ['/say', '/dm']) test(`${route}: lost accepted response then failed ACK survive two real adapter restarts`, { timeout: 45000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-delivery-'));
  const runDir = path.join(root, '.sameroof/run');
  const outbox = path.join(root, 'rooms/Agent/state/delivery-outbox.json');
  let coordinator, proxy;
  try {
    for (const dir of ['rooms/Human', 'rooms/Agent/state', '.sameroof/run', 'state']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, 'house.yaml'), 'schema_version: 1\nname: fixture\ntimezone: UTC\ndefaults:\n  runtime: broker-direct\n  plugins: [living-room]\n  heartbeat: {enabled: false}\n  context: {recent_messages: 5, recent_max_chars: 2000, memory_hits: 0, memory_recent: 0}\n  subagent: {enabled: false}\ncredentials: []\nnotify: {admin: Human}\n');
    for (const [name, species] of [['Human', 'human'], ['Agent', 'agent']]) fs.writeFileSync(path.join(root, 'rooms', name, 'room.yaml'), `schema_version: 1\nid: resident_${name.toLowerCase()}_01\nname: ${name}\nspecies: ${species}\nheartbeat: {enabled: false}\n`);
    coordinator = createLivingRoom({ houseDir: root, runDir, dataDir: path.join(root, 'state'), port: 0, sayLimit: 100 });
    const port = (await coordinator.listen()).port;
    const human = coordinator.tokenStore.issue('resident_human_01').token;
    const agent = coordinator.tokenStore.issue('resident_agent_01').token;
    fs.writeFileSync(path.join(runDir, 'living-room-tokens.json'), JSON.stringify({ resident_agent_01: agent, resident_human_01: human }));
    const request = async (url, token = human, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
      assert.equal(response.status, 200); return response.json();
    };
    const input = await request('/say', human, { text: '@Agent please answer' });
    let mode = 'lose-response'; const keys = []; let acknowledgements = 0;
    proxy = http.createServer((q, s) => {
      const publication = q.method === 'POST' && q.url === route;
      let body = ''; q.on('data', c => { body += c; });
      q.on('end', () => {
        if (publication) keys.push(JSON.parse(body).client_request_id);
        if (q.url === '/inbox/ack') {
          acknowledgements++;
          if (mode === 'reject-ack') { s.writeHead(500, { 'content-type': 'application/json' }); s.end('{"error":"injected"}'); return; }
        }
        const up = http.request({ hostname: '127.0.0.1', port, path: q.url, method: q.method, headers: q.headers }, r => {
          if (publication && mode === 'lose-response') {
            // Coordinator has really committed. Send a truncated HTTP response,
            // not a simulated model failure, so response-aborted is exercised.
            r.resume(); r.on('end', () => { s.writeHead(200, { 'content-type': 'application/json', 'content-length': 9999 }); s.write('{'); setTimeout(() => s.destroy(), 20); });
          } else { s.writeHead(r.statusCode, r.headers); r.pipe(s); }
        });
        up.on('error', () => s.destroy()); up.end(body);
      });
    });
    await new Promise(r => proxy.listen(0, '127.0.0.1', r));
    const launch = () => exec(process.execPath, [path.join(__dirname, '../test-support/launch-delivery-adapter.js')], {
      env: { ...process.env, HOME: root, SAMEROOF_ROOT: root, SAMEROOF_LR: 'http://127.0.0.1:' + proxy.address().port, DELIVERY_REPLY: route === '/dm' ? 'DM: Human fixture answer' : 'fixture answer' }, timeout: 18000,
    });
    const first = await launch();
    assert.equal((first.stdout.match(/FIXTURE_MODEL_CALL/g) || []).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(outbox)).phase, 'prepared');
    assert.equal(acknowledgements, 0, 'never ACK before confirming publication');
    assert.ok((await request('/inbox', agent)).some(m => m.id === input.id));
    mode = 'reject-ack';
    const second = await launch();
    assert.doesNotMatch(second.stdout, /FIXTURE_MODEL_CALL/);
    assert.equal(JSON.parse(fs.readFileSync(outbox)).phase, 'accepted');
    assert.deepEqual(keys, [keys[0], keys[0]]); assert.match(keys[0], /^send_[a-f0-9]{32}$/);
    assert.ok((await request('/inbox', agent)).some(m => m.id === input.id));
    mode = 'pass';
    const third = await launch();
    assert.doesNotMatch(third.stdout, /FIXTURE_MODEL_CALL/);
    assert.equal(keys.length, 2, 'accepted outbox retries only ACK, not publication');
    assert.equal(fs.existsSync(outbox), false);
    assert.equal((await request('/inbox', agent)).some(m => m.id === input.id), false);
    const history = await request(route === '/dm' ? '/dm/history?with=resident_agent_01' : '/history?limit=20');
    assert.equal(history.filter(m => m.from_id === 'resident_agent_01' && m.text === 'fixture answer').length, 1);
  } finally {
    if (proxy) { proxy.closeAllConnections(); await new Promise(r => proxy.close(r)); }
    if (coordinator) await coordinator.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
