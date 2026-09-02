'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLivingRoom } = require('../server');

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET', headers: {
      ...(options.token ? { authorization: 'Bearer ' + options.token } : {}),
      ...(options.ip ? { 'cf-connecting-ip': options.ip } : {}),
      ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {})
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let value = text;
        try { value = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: value });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-lr-'));
  fs.mkdirSync(path.join(root, 'rooms', '甲'), { recursive: true });
  fs.mkdirSync(path.join(root, 'rooms', '乙'), { recursive: true });
  fs.mkdirSync(path.join(root, 'apps', 'house'), { recursive: true });
  fs.writeFileSync(path.join(root, 'rooms', '甲', 'room.yaml'), 'id: resident_alpha_01\nname: 甲\nspecies: human\n');
  fs.writeFileSync(path.join(root, 'rooms', '乙', 'room.yaml'), 'id: resident_beta_01\nname: 乙\nspecies: agent\n');
  fs.writeFileSync(path.join(root, 'apps', 'house', 'index.html'), '<!doctype html>');
  return root;
}

test('public boundary uses bearer auth, IP failure limit, resident say limit, and hot token rotation', async () => {
  const root = fixture();
  const room = createLivingRoom({ houseDir: root, runDir: path.join(root, 'run'), dataDir: path.join(root, 'state'), port: 0, authFailureLimit: 2, authBlockMs: 5000, sayLimit: 1 });
  try {
    const address = await room.listen();
    const port = address.port;
    const alpha = room.tokenStore.issue('resident_alpha_01').token;
    assert.equal((await request(port, '/me', { token: alpha })).body.id, 'resident_alpha_01');
    assert.equal((await request(port, '/me?token=' + encodeURIComponent(alpha))).status, 401);
    assert.equal((await request(port, '/me', { token: 'x'.repeat(32) })).status, 401);
    assert.equal((await request(port, '/me', { token: 'x'.repeat(32) })).status, 401);
    assert.equal((await request(port, '/me', { token: 'x'.repeat(32), ip: '203.0.113.20' })).status, 401);
    assert.equal((await request(port, '/me', { token: 'x'.repeat(32), ip: '203.0.113.20' })).status, 429);
    assert.equal((await request(port, '/me', { token: alpha, ip: '203.0.113.21' })).status, 200);
    assert.equal((await request(port, '/say', { method: 'POST', token: alpha, body: { text: '第一句' } })).status, 200);
    const limited = await request(port, '/say', { method: 'POST', token: alpha, body: { text: '第二句' } });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) >= 1);
    const rotated = room.tokenStore.rotate('resident_alpha_01').token;
    assert.equal((await request(port, '/me', { token: alpha, ip: '203.0.113.22' })).status, 401);
    assert.equal((await request(port, '/me', { token: rotated })).status, 200);
    room.tokenStore.revoke('resident_alpha_01');
    assert.equal((await request(port, '/me', { token: rotated, ip: '203.0.113.23' })).status, 401);
  } finally {
    await room.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
