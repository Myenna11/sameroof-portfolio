// V2-SEARCH：GET /search?q=&resident=&limit=：扫活的 shift + 归档；回放 retract；不搜 system；人 only；片段前后 50 字。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), http = require('node:http'), os = require('node:os'), path = require('node:path');
const test = require('node:test');
const { createLivingRoom } = require('../server');
const get = (port, p, token) => new Promise((resolve, reject) => { const req = http.request({ hostname: '127.0.0.1', port, path: p.replace(/[^\x00-\x7F]+/g, m => encodeURIComponent(m)), headers: { authorization: 'Bearer ' + token } }, res => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => { let v = Buffer.concat(c).toString(); try { v = JSON.parse(v); } catch {} resolve({ status: res.statusCode, body: v }); }); }); req.on('error', reject); req.end(); });
const L = o => JSON.stringify(o) + '\n';

test('GET /search：活的+归档都扫，retract 剔掉，system 不搜，resident 筛，片段与排序', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-search-'));
  for (const [n, y] of [['甲', 'id: resident_alpha_01\nname: 甲\nspecies: human\n'], ['乙', 'id: resident_beta_01\nname: 乙\nspecies: agent\n'], ['丙', 'id: resident_gamma_01\nname: 丙\nspecies: agent\n']]) { fs.mkdirSync(path.join(root, 'rooms', n), { recursive: true }); fs.writeFileSync(path.join(root, 'rooms', n, 'room.yaml'), y); }
  fs.mkdirSync(path.join(root, 'apps', 'house'), { recursive: true }); fs.writeFileSync(path.join(root, 'apps', 'house', 'index.html'), '<!doctype html>');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'house.yaml'), path.join(root, 'house.yaml'));
  fs.mkdirSync(path.join(root, 'state', 'shifts'), { recursive: true });
  // 乙：活的 shift——system 里也有"杯子"（不该命中）；一条被 retract 的 user 含"杯子"（不该命中）；一条 assistant 含"杯子"（命中）
  fs.writeFileSync(path.join(root, 'state', 'shift-resident_beta_01.jsonl'),
    L({ op: 'msg', role: 'system', content: '你是乙，喜欢杯子', ts: '2026-09-08T01:00:00Z' }) +
    L({ op: 'msg', role: 'user', content: '我今天买了个杯子', ts: '2026-09-08T01:01:00Z' }) + L({ op: 'retract', ts: '2026-09-08T01:01:01Z' }) +
    L({ op: 'msg', role: 'user', content: '猜猜什么颜色', ts: '2026-09-08T01:02:00Z' }) +
    L({ op: 'msg', role: 'assistant', content: 'x'.repeat(80) + '蓝色的杯子吧' + 'y'.repeat(80), ts: '2026-09-08T01:03:00Z' }));
  // 乙：归档一班——更早，含"杯子"
  fs.writeFileSync(path.join(root, 'state', 'shifts', '2026-09-07T10-00-00-shift-resident_beta_01.jsonl'),
    L({ op: 'msg', role: 'system', content: '你是乙', ts: '2026-09-07T09:00:00Z' }) + L({ op: 'msg', role: 'user', content: '杯子碎了', ts: '2026-09-07T09:30:00Z' }) + L({ op: 'msg', role: 'assistant', content: '再买一个', ts: '2026-09-07T09:31:00Z' }));
  // 丙：也提到杯子
  fs.writeFileSync(path.join(root, 'state', 'shift-resident_gamma_01.jsonl'), L({ op: 'msg', role: 'user', content: '乙的杯子好看', ts: '2026-09-08T02:00:00Z' }));
  const room = createLivingRoom({ houseDir: root, runDir: path.join(root, 'run'), dataDir: path.join(root, 'state'), port: 0 });
  try {
    const port = (await room.listen()).port;
    const alpha = room.tokenStore.issue('resident_alpha_01').token, beta = room.tokenStore.issue('resident_beta_01').token;
    assert.equal((await get(port, '/search?q=杯子', beta)).status, 403);
    assert.equal((await get(port, '/search?q=', alpha)).status, 400);
    assert.equal((await get(port, '/search?q=杯子&resident=没这人', alpha)).status, 404);
    let r = await get(port, '/search?q=杯子', alpha);
    assert.equal(r.status, 200); assert.equal(r.body.total, 3); assert.equal(r.body.files_scanned, 3);
    assert.deepEqual(r.body.hits.map(h => h.resident + ':' + h.role), ['丙:user', '乙:assistant', '乙:user']);   // ts 倒序
    const a = r.body.hits[1]; assert.equal(a.live, true); assert.ok(a.content_snippet.startsWith('…') && a.content_snippet.endsWith('…')); assert.ok(a.content_snippet.includes('蓝色的杯子吧')); assert.ok(a.content_snippet.length < 120);
    const old = r.body.hits[2]; assert.equal(old.live, false); assert.ok(old.shift_file.startsWith('state/shifts/'));
    assert.ok(!r.body.hits.some(h => h.content_snippet.includes('我今天买了个杯子')), 'retract 的不该命中');
    r = await get(port, '/search?q=杯子&resident=乙&limit=1', alpha);
    assert.equal(r.body.total, 2); assert.equal(r.body.hits.length, 1); assert.equal(r.body.files_scanned, 2);
    r = await get(port, '/search?q=' + encodeURIComponent('猜猜'), alpha); assert.equal(r.body.total, 1);
    r = await get(port, '/search?q=' + encodeURIComponent('喜欢杯子'), alpha); assert.equal(r.body.total, 0, 'system 不搜');
  } finally { await room.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
