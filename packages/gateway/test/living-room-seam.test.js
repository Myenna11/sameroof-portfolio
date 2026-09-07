'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createGateway } = require('../server');
const { createLivingRoom } = require('../../living-room/server');

function request(port, pathname, options = {}) { return new Promise((resolve, reject) => { const data = options.body === undefined ? '' : JSON.stringify(options.body); const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET', headers: { ...(options.token ? { authorization: 'Bearer ' + options.token } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, body: JSON.parse(text || '{}') }); }); }); req.on('error', reject); req.end(data); }); }

test('real seam: immutable intent -> living-room decision stream -> path executor -> private result inbox', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-real-seam-'));
  let room; let gateway;
  try {
    for (const [name, id, species] of [['甲', 'resident_alpha_01', 'human'], ['乙', 'resident_beta_01', 'agent']]) { fs.mkdirSync(path.join(root, 'rooms', name), { recursive: true }); fs.writeFileSync(path.join(root, 'rooms', name, 'room.yaml'), `schema_version: 1\nid: ${id}\nname: ${name}\nspecies: ${species}\n`); }
    fs.mkdirSync(path.join(root, 'apps', 'house'), { recursive: true }); fs.writeFileSync(path.join(root, 'apps', 'house', 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(root, 'house.yaml'), 'schema_version: 1\nname: seam\ntimezone: UTC\ndefaults:\n  permissions:\n    core.fs.read: approve\n    core.fs.write: approve\n');
    const tokenFile = path.join(root, 'run', 'gateway-service.token'); fs.mkdirSync(path.dirname(tokenFile), { recursive: true }); fs.writeFileSync(tokenFile, 'service-' + 'x'.repeat(48) + '\n', { mode: 0o600 });
    room = createLivingRoom({ houseDir: root, runDir: path.join(root, 'run'), dataDir: path.join(root, 'living-state'), port: 0, gatewayServiceTokenFile: tokenFile }); const port = (await room.listen()).port;
    const alpha = room.tokenStore.issue('resident_alpha_01').token; const beta = room.tokenStore.issue('resident_beta_01').token;
    gateway = createGateway({ houseDir: root, runDir: path.join(root, 'gateway-run'), stateDir: path.join(root, 'gateway-state'), serviceTokenFile: tokenFile, livingRoomPort: port, lockRequired: false, bwrapProbe: false });
    const adapter = gateway.issueAdapterToken('resident_beta_01').token;
    const intent = { request_id: 'req_realseam1', resident_id: 'resident_beta_01', run_id: 'run_realseam1', action: 'core.fs.write', params: { root_id: 'own-room', path: 'note.md', content: '真实接缝', encoding: 'utf8', mode: 'create' }, requested_ttl_seconds: 600 };
    const registered = gateway.registerIntent(intent, adapter);
    const ask = await request(port, '/approval', { method: 'POST', token: beta, body: registered.approval_body }); assert.equal(ask.status, 200, JSON.stringify(ask.body));
    const decided = await request(port, '/approval/' + ask.body.approval_id, { method: 'POST', token: alpha, body: { decision: 'allow' } }); assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.deepEqual(await gateway.pollApprovalResults(), { processed: 1, next_seq: 1 });
    assert.equal(fs.readFileSync(path.join(root, 'rooms', '乙', 'note.md'), 'utf8'), '真实接缝');
    const inbox = await request(port, '/inbox', { token: beta }); const result = inbox.body.find(x => x.kind === 'result'); assert.ok(result); assert.equal(result.meta.status, 'succeeded'); assert.equal(result.meta.gateway_request_id, intent.request_id); assert.equal(result.meta.deliver, 'interrupt');
    assert.equal((await request(port, '/history', { token: alpha })).body.some(x => x.kind === 'result'), false);

    const content = 'x'.repeat(1199); fs.writeFileSync(path.join(root, 'rooms', '乙', 'near-limit.txt'), content);
    const readIntent = { request_id: 'req_realseam2', resident_id: 'resident_beta_01', run_id: 'run_realseam2', action: 'core.fs.read', params: { root_id: 'own-room', path: 'near-limit.txt', max_bytes: 1200 }, requested_ttl_seconds: 600 };
    const readRegistered = gateway.registerIntent(readIntent, adapter); const readAsk = await request(port, '/approval', { method: 'POST', token: beta, body: readRegistered.approval_body }); assert.equal(readAsk.status, 200, JSON.stringify(readAsk.body));
    const readDecided = await request(port, '/approval/' + readAsk.body.approval_id, { method: 'POST', token: alpha, body: { decision: 'allow' } }); assert.equal(readDecided.status, 200, JSON.stringify(readDecided.body));
    assert.deepEqual(await gateway.pollApprovalResults(), { processed: 1, next_seq: 2 });
    const readInbox = await request(port, '/inbox', { token: beta }); const readResult = readInbox.body.find(x => x.kind === 'result' && x.meta?.gateway_request_id === readIntent.request_id); assert.ok(readResult); assert.match(readResult.text, /x{100}/); assert.equal(readResult.text.endsWith(content), true); assert.equal(readResult.meta.deliver, 'interrupt');
  } finally { if (gateway) await gateway.close(); if (room) await room.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
