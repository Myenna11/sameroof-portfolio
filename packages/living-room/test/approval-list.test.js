// V2-AP：GET /approval 待审列表——只给人看；默认 pending；过期的 pending 顺手标 expired；all/allowed/denied/expired 可筛。
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
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET', headers: { ...(options.token ? { authorization: 'Bearer ' + options.token } : {}), ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { const t = Buffer.concat(chunks).toString(); let v = t; try { v = JSON.parse(t); } catch {} resolve({ status: res.statusCode, body: v }); });
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-ap-'));
  for (const [n, y] of [['甲', 'id: resident_alpha_01\nname: 甲\nspecies: human\n'], ['乙', 'id: resident_beta_01\nname: 乙\nspecies: agent\n']]) { fs.mkdirSync(path.join(root, 'rooms', n), { recursive: true }); fs.writeFileSync(path.join(root, 'rooms', n, 'room.yaml'), y); }
  fs.mkdirSync(path.join(root, 'apps', 'house'), { recursive: true }); fs.writeFileSync(path.join(root, 'apps', 'house', 'index.html'), '<!doctype html>');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'house.yaml'), path.join(root, 'house.yaml'));
  return root;
}

test('GET /approval：人能看 pending 列表，agent 403；决定后从 pending 消失；过期的自动标 expired', async () => {
  const root = fixture();
  const room = createLivingRoom({ houseDir: root, runDir: path.join(root, 'run'), dataDir: path.join(root, 'state'), port: 0, approvalLimit: 50 });
  try {
    const port = (await room.listen()).port;
    const alpha = room.tokenStore.issue('resident_alpha_01').token;
    const beta = room.tokenStore.issue('resident_beta_01').token;
    // 乙申请两条（legacy 型即可）；第二条 ttl 最短 30s，之后把 expires_ts 直接改成过去模拟过期
    const a1 = await request(port, '/approval', { method: 'POST', token: beta, body: { action: 'core.fs.write', params: { root_id: 'own-room', path: 'a.md', content: 'x', mode: 'create' } } });
    const a2 = await request(port, '/approval', { method: 'POST', token: beta, body: { action: 'core.exec', params: { argv: ['ls'] }, ttl_seconds: 30 } });
    assert.equal(a1.status, 200); assert.equal(a2.status, 200);
    // agent 看不了
    assert.equal((await request(port, '/approval', { token: beta })).status, 403);
    // 人看：两条 pending，带 resident_name / action / params / created_ts
    let list = await request(port, '/approval', { token: alpha });
    assert.equal(list.status, 200); assert.equal(list.body.length, 2);
    assert.deepEqual(list.body.map(x => x.status), ['pending', 'pending']);
    const row = list.body.find(x => x.approval_id === a1.body.approval_id);
    assert.equal(row.resident_name, '乙'); assert.equal(row.action, 'core.fs.write'); assert.equal(row.params.path, 'a.md'); assert.ok(row.created_ts && row.expires_ts);
    // 非法 status 400
    assert.equal((await request(port, '/approval?status=weird', { token: alpha })).status, 400);
    // 决定 a1 → pending 只剩 a2；allowed 筛得到 a1
    assert.equal((await request(port, '/approval/' + a1.body.approval_id, { method: 'POST', token: alpha, body: { decision: 'allow' } })).status, 200);
    list = await request(port, '/approval', { token: alpha });
    assert.deepEqual(list.body.map(x => x.approval_id), [a2.body.approval_id]);
    assert.equal((await request(port, '/approval?status=allowed', { token: alpha })).body[0].approval_id, a1.body.approval_id);
    // 模拟 a2 过期
    room.db.prepare("UPDATE approvals SET expires_ts=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), a2.body.approval_id);
    list = await request(port, '/approval', { token: alpha });
    assert.equal(list.body.length, 0);
    const exp = await request(port, '/approval?status=expired', { token: alpha });
    assert.equal(exp.body.length, 1); assert.equal(exp.body[0].approval_id, a2.body.approval_id);
    assert.equal((await request(port, '/approval?status=all', { token: alpha })).body.length, 2);
  } finally { await room.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
