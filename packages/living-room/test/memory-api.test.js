// 记忆审核队列（W4）：四个接口的权限矩阵（人类 / 本人 / 别人）+ 一条 happy path。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLivingRoom } = require('../server');
const memoryPlugin = require('@sameroof/plugin-memory');

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET', headers: {
      ...(options.token ? { authorization: 'Bearer ' + options.token } : {}),
      ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {})
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { let value = Buffer.concat(chunks).toString(); try { value = JSON.parse(value); } catch {} resolve({ status: res.statusCode, body: value }); });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-memapi-'));
  for (const [name, yamlText] of [['甲', 'id: resident_alpha_01\nname: 甲\nspecies: human\n'], ['乙', 'id: resident_beta_01\nname: 乙\nspecies: agent\n'], ['丙', 'id: resident_gamma_01\nname: 丙\nspecies: agent\n']]) {
    fs.mkdirSync(path.join(root, 'rooms', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'rooms', name, 'room.yaml'), yamlText);
  }
  fs.mkdirSync(path.join(root, 'apps', 'house'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps', 'house', 'index.html'), '<!doctype html>');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'house.yaml'), path.join(root, 'house.yaml'));
  return root;
}

test('memory api：权限矩阵与 happy path', async () => {
  const root = fixture();
  const room = createLivingRoom({ houseDir: root, runDir: path.join(root, 'run'), dataDir: path.join(root, 'state'), port: 0 });
  try {
    const port = (await room.listen()).port;
    const human = room.tokenStore.issue('resident_alpha_01').token;
    const self = room.tokenStore.issue('resident_beta_01').token;
    const other = room.tokenStore.issue('resident_gamma_01').token;
    const M = memoryPlugin.open(path.join(root, 'rooms', '乙'));
    const authored = M.remember({ content: '维护者说我叫乙', source: 'human', by: 'resident_alpha_01', fact_key: 'self.name' });
    const heard = M.remember({ content: '群里有人说周五聚餐', source: 'inbox' });
    const heard2 = M.remember({ content: '群里又说周五聚餐带酒', source: 'inbox' });
    const selfNote = M.remember({ content: '我今天见到了新邻居', source: 'self', by: 'resident_beta_01' });
    const P = '/rooms/resident_beta_01/memory/';

    // GET pending：人 200 / 本人 200 / 别人 403；按名字找屋也行
    assert.equal((await request(port, P + 'pending', { token: human })).status, 200);
    const mine = await request(port, P + 'pending', { token: self });
    assert.equal(mine.status, 200); assert.deepEqual(mine.body.map(x => x.id).sort(), [heard.id, heard2.id, selfNote.id].sort());
    assert.equal(mine.body.find(x => x.id === selfNote.id).authored, true);
    assert.equal((await request(port, P + 'pending', { token: other })).status, 403);
    assert.equal((await request(port, '/rooms/' + encodeURIComponent('乙') + '/memory/pending', { token: human })).status, 200);
    assert.equal((await request(port, '/rooms/' + encodeURIComponent('没有人') + '/memory/pending', { token: human })).status, 404);

    // approve：只有人。本人 403 MEM-HUMAN-ONLY；别人 403；人通过亲笔的 self 记录 200
    const a1 = await request(port, P + selfNote.id + '/approve', { method: 'POST', token: self });
    assert.equal(a1.status, 403); assert.equal(a1.body.error.code, 'MEM-HUMAN-ONLY');
    assert.equal((await request(port, P + selfNote.id + '/approve', { method: 'POST', token: other })).status, 403);
    const a2 = await request(port, P + selfNote.id + '/approve', { method: 'POST', token: human });
    assert.equal(a2.status, 200); assert.equal(a2.body.review, 'approved');
    assert.equal((await request(port, P + selfNote.id + '/approve', { method: 'POST', token: human })).body.error.code, 'MEM-STATE');
    assert.equal((await request(port, P + 'mem_000000000000/approve', { method: 'POST', token: human })).status, 404);
    assert.equal((await request(port, P + 'nope/approve', { method: 'POST', token: human })).status, 400);

    // discard：别人 403；本人 200
    assert.equal((await request(port, P + heard2.id + '/discard', { method: 'POST', token: other })).status, 403);
    const d = await request(port, P + heard2.id + '/discard', { method: 'POST', token: self });
    assert.equal(d.status, 200); assert.equal(d.body.review, 'discarded');

    // merge：本人 403；人 200
    assert.equal((await request(port, P + 'merge', { method: 'POST', token: self, body: { ids: [heard.id, selfNote.id], content: '合' } })).status, 403);
    assert.equal((await request(port, P + 'merge', { method: 'POST', token: human, body: { ids: [heard.id], content: '合' } })).status, 400);
    const mg = await request(port, P + 'merge', { method: 'POST', token: human, body: { ids: [heard.id, selfNote.id], content: '周五聚餐时我见到了新邻居' } });
    assert.equal(mg.status, 200); assert.deepEqual([mg.body.review, mg.body.version_status, mg.body.authored], ['approved', 'current', true]);
    assert.equal(M.get(heard.id).merged_into, mg.body.id);

    // supersede：别人 403；本人对亲笔 403 MEM-HUMAN-ONLY；本人对非亲笔 200；人对亲笔 200 → 旧的不动 → 本人 approve 403 → 人 approve 200 → 旧的 superseded
    assert.equal((await request(port, P + 'supersede', { method: 'POST', token: other, body: { old_id: authored.id, content: 'x' } })).status, 403);
    const s1 = await request(port, P + 'supersede', { method: 'POST', token: self, body: { old_id: authored.id, content: '维护者说我叫小乙' } });
    assert.equal(s1.status, 403); assert.equal(s1.body.error.code, 'MEM-HUMAN-ONLY');
    const selfMem = M.remember({ content: '我记得今天下雨', source: 'self', by: 'resident_alpha_01' });   // 自己 self 写的亲笔：自己可以提新版本，仍 under_review
    const s0 = await request(port, P + 'supersede', { method: 'POST', token: self, body: { old_id: selfMem.id, content: '我记得今天下大雨' } });
    assert.equal(s0.status, 200); assert.equal(s0.body.version_status, 'under_review');
    const ext = M.remember({ content: '外面看到的旧消息', source: 'external' });
    const s2 = await request(port, P + 'supersede', { method: 'POST', token: self, body: { old_id: ext.id, content: '外面看到的新消息' } });
    assert.equal(s2.status, 200); assert.equal(s2.body.version_status, 'under_review');
    const s3 = await request(port, P + 'supersede', { method: 'POST', token: human, body: { old_id: authored.id, content: '维护者说我叫小乙' } });
    assert.equal(s3.status, 200); assert.deepEqual([s3.body.supersedes, s3.body.review, s3.body.fact_key], [authored.id, 'pending', 'self.name']);
    assert.deepEqual([M.get(authored.id).content, M.get(authored.id).version_status], ['维护者说我叫乙', 'current']);
    assert.equal((await request(port, P + s3.body.id + '/approve', { method: 'POST', token: self })).body.error.code, 'MEM-HUMAN-ONLY');
    assert.equal((await request(port, P + s3.body.id + '/approve', { method: 'POST', token: human })).status, 200);
    assert.deepEqual([M.get(authored.id).version_status, M.get(authored.id).superseded_by, M.get(authored.id).content], ['superseded', s3.body.id, '维护者说我叫乙']);
    assert.deepEqual((await M.recall('维护者说我叫')).map(x => x.id), [s3.body.id]);

    // 只读清单也走折叠：旧字段 reviewed 兼容，新字段带出来
    const list = await request(port, '/rooms/resident_beta_01/memory', { token: human });
    assert.equal(list.status, 200);
    const row = list.body.find(x => x.id === authored.id);
    assert.deepEqual([row.reviewed, row.review, row.authored, row.version_status, row.superseded_by], [true, 'approved', true, 'superseded', s3.body.id]);

    // 每次操作发一条 note 活动
    const acts = await request(port, '/activity', { token: human });
    const notes = acts.body.filter(x => x.kind === 'note' && x.meta && x.meta.room_id === 'resident_beta_01');
    assert.deepEqual(new Set(notes.map(x => x.meta.op)), new Set(['approve', 'discard', 'merge', 'supersede']));
    assert.ok(notes.length >= 6);
  } finally {
    await room.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
