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
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'house.yaml'), path.join(root, 'house.yaml'));
  return root;
}

test('public boundary uses bearer auth, IP failure limit, resident say limit, and hot token rotation', async () => {
  const root = fixture();
  const sent = [];
  const notificationClient = { publicKey: async () => ({ public_key: 'test-public-key' }), send: async (subscription, payload) => { sent.push({ subscription, payload }); return { delivered: true }; } };
  const room = createLivingRoom({ houseDir: root, runDir: path.join(root, 'run'), dataDir: path.join(root, 'state'), port: 0, authFailureLimit: 2, authBlockMs: 5000, sayLimit: 1, notificationClient });
  try {
    const address = await room.listen();
    const port = address.port;
    const alpha = room.tokenStore.issue('resident_alpha_01').token;
    const beta = room.tokenStore.issue('resident_beta_01').token;
    assert.equal((await request(port, '/me', { token: alpha })).body.id, 'resident_alpha_01');
    assert.equal((await request(port, '/me?token=' + encodeURIComponent(alpha))).status, 401);
    assert.equal((await request(port, '/me', { token: 'x'.repeat(32) })).status, 401);
    assert.equal((await request(port, '/me', { token: 'x'.repeat(32) })).status, 401);
    assert.equal((await request(port, '/me', { token: 'x'.repeat(32), ip: '203.0.113.20' })).status, 401);
    assert.equal((await request(port, '/me', { token: 'x'.repeat(32), ip: '203.0.113.20' })).status, 429);
    assert.equal((await request(port, '/me', { token: alpha, ip: '203.0.113.21' })).status, 200);
    assert.equal((await request(port, '/push/vapid-public-key', { token: alpha })).body.public_key, 'test-public-key');
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/test-device', expirationTime: null, keys: { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) } };
    assert.equal((await request(port, '/push/subscribe', { method: 'POST', token: alpha, body: subscription })).status, 200);
    assert.equal((await request(port, '/push/subscribe', { method: 'POST', token: beta, body: subscription })).status, 403);
    assert.equal((await request(port, '/say', { method: 'POST', token: beta, body: { text: '叫维护者回家' } })).status, 200);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.body, '叫维护者回家');
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

test('GET /runs（V2-4A）：读 state/runs/*.jsonl，倒序、limit、按住户筛、只给家人', async () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'rooms', '丙'), { recursive: true });
  fs.writeFileSync(path.join(root, 'rooms', '丙', 'room.yaml'), 'id: resident_gamma_01\nname: 丙\nspecies: agent\n');
  fs.mkdirSync(path.join(root, 'state', 'runs'), { recursive: true });
  const rec = (id, resident_id, ts, extra = {}) => JSON.stringify({ id, resident_id, ts, reason: '心跳', lane: 'heartbeat', status: 'silent', ms: 1200, model_calls: 1, heard: [{ big: 'x'.repeat(50) }], ...extra }) + '\n';
  fs.writeFileSync(path.join(root, 'state', 'runs', 'resident_beta_01.jsonl'), rec('run_b1', 'resident_beta_01', '2026-09-07T10:00:00.000Z') + 'not json\n' + rec('run_b2', 'resident_beta_01', '2026-09-07T12:00:00.000Z', { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, error: 'boom' }));
  fs.writeFileSync(path.join(root, 'state', 'runs', 'resident_gamma_01.jsonl'), rec('run_g1', 'resident_gamma_01', '2026-09-07T11:00:00.000Z'));
  const room = createLivingRoom({ houseDir: root, runDir: path.join(root, 'run'), dataDir: path.join(root, 'state'), port: 0 });
  try {
    const port = (await room.listen()).port;
    const alpha = room.tokenStore.issue('resident_alpha_01').token;
    const beta = room.tokenStore.issue('resident_beta_01').token;
    const all = await request(port, '/runs', { token: alpha });
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.map(r => r.id), ['run_b2', 'run_g1', 'run_b1']);                       // 合并、最新在前，坏行跳过
    assert.deepEqual(Object.keys(all.body[0]).sort(), ['error', 'id', 'lane', 'model_calls', 'ms', 'reason', 'resident', 'resident_id', 'status', 'ts', 'usage']);   // heard 这种大字段不带
    assert.equal(all.body[0].resident, '乙'); assert.equal(all.body[0].usage.total_tokens, 15); assert.equal(all.body[0].error, 'boom');
    assert.equal(all.body[1].error, undefined); assert.equal(all.body[1].usage, null);
    assert.deepEqual((await request(port, '/runs?limit=2', { token: alpha })).body.map(r => r.id), ['run_b2', 'run_g1']);
    assert.deepEqual((await request(port, '/runs?resident=resident_beta_01', { token: alpha })).body.map(r => r.id), ['run_b2', 'run_b1']);
    assert.deepEqual((await request(port, '/runs?resident=' + encodeURIComponent('丙'), { token: alpha })).body.map(r => r.id), ['run_g1']);   // 名字也认
    assert.equal((await request(port, '/runs?resident=nobody', { token: alpha })).status, 404);
    assert.equal((await request(port, '/runs?limit=0', { token: alpha })).status, 400);
    assert.equal((await request(port, '/runs', { token: beta })).status, 403);                        // 住户不能看
  } finally {
    await room.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('GET /quota（V2-Q）：按住户 provider 分组并发取数，单家失败只坏一张卡，只给家人', async () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'rooms', '乙', 'room.yaml'), 'id: resident_beta_01\nname: 乙\nspecies: agent\nmodel: {provider: kimi-coding, id: k3}\n');
  fs.mkdirSync(path.join(root, 'rooms', '丙'), { recursive: true });
  fs.writeFileSync(path.join(root, 'rooms', '丙', 'room.yaml'), 'id: resident_gamma_01\nname: 丙\nspecies: agent\nmodel: {provider: zhipu, id: glm}\n');
  const quotaProviders = {
    kimi: { label: 'Kimi', fetch: async () => ({ status: 'ok', windows: [{ label: '5 小时窗', usedPercent: 12, resetAt: '2026-09-08T00:00:00.000Z' }] }) },
    glm: { label: 'GLM', fetch: async () => { throw Object.assign(new Error('没 coding plan'), { code: 'QUOTA-NO-PLAN' }); } },
  };
  const room = createLivingRoom({ houseDir: root, runDir: path.join(root, 'run'), dataDir: path.join(root, 'state'), port: 0, quotaProviders });
  try {
    const port = (await room.listen()).port;
    const alpha = room.tokenStore.issue('resident_alpha_01').token;
    const beta = room.tokenStore.issue('resident_beta_01').token;
    const r = await request(port, '/quota', { token: alpha });
    assert.equal(r.status, 200);
    const by = Object.fromEntries(r.body.providers.map(c => [c.provider, c]));
    assert.deepEqual(Object.keys(by).sort(), ['glm', 'kimi']);
    assert.equal(by.kimi.status, 'ok'); assert.deepEqual(by.kimi.residents, ['乙']); assert.equal(by.kimi.windows[0].usedPercent, 12);
    assert.equal(by.glm.status, 'error'); assert.equal(by.glm.code, 'QUOTA-NO-PLAN'); assert.deepEqual(by.glm.windows, []);
    assert.ok(fs.existsSync(path.join(root, 'state', 'quota-cache.json')));
    assert.equal((await request(port, '/quota', { token: beta })).status, 403);
  } finally {
    await room.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
