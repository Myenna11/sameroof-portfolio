// K1：PUT /rooms/:id/extensions —— 本人 200 且 room.yaml 只有 extensions 变；别人 403；非法 namespace 400；null 删段；schema 不过 400 不写盘；GET 能读到。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const { createLivingRoom } = require('../server');

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

// 乙的 room.yaml 尽量像真房间：有 model / heartbeat / relations / avatar / 已有的 extensions，好验"别的字段一根毛都没动"
const YI = `schema_version: 1
id: resident_beta_01
name: 乙
species: agent
model:
  provider: zhipu
  id: glm-4
  auth: {mode: broker, credential: test-cheap}
runtime: pi
plugins: [memory, living-room]
heartbeat: {enabled: true, mode: minimal, interval: adaptive, quiet_hours: "01:00-09:00", budget: {per_day: {requests: 40, tokens: 200000}, on_exceeded: passive}}
relations:
  甲: {kind: 家人}
avatar: {emoji: "🌸"}
extensions:
  dev.sameroof.limits: {agent_hops: 3}
  dev.sameroof.routines:
    - {id: morning, cron: "0 9 * * *", prompt: 早安}
`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-extapi-'));
  for (const [name, yamlText] of [['甲', 'schema_version: 1\nid: resident_alpha_01\nname: 甲\nspecies: human\n'], ['乙', YI], ['丙', 'schema_version: 1\nid: resident_gamma_01\nname: 丙\nspecies: agent\nmodel: {provider: zhipu, id: glm-4}\n']]) {
    fs.mkdirSync(path.join(root, 'rooms', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'rooms', name, 'room.yaml'), yamlText);
  }
  fs.mkdirSync(path.join(root, 'apps', 'house'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps', 'house', 'index.html'), '<!doctype html>');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'house.yaml'), path.join(root, 'house.yaml'));
  return root;
}
const strip = doc => { const o = { ...doc }; delete o.extensions; return o; };

test('rooms extensions：PUT 权限、整段替换、null 删段、校验不过不写盘、GET 读回', async () => {
  const root = fixture();
  const room = createLivingRoom({ houseDir: root, runDir: path.join(root, 'run'), dataDir: path.join(root, 'state'), port: 0 });
  const file = path.join(root, 'rooms', '乙', 'room.yaml');
  try {
    const port = (await room.listen()).port;
    const human = room.tokenStore.issue('resident_alpha_01').token;
    const self = room.tokenStore.issue('resident_beta_01').token;
    const other = room.tokenStore.issue('resident_gamma_01').token;
    const P = '/rooms/resident_beta_01/extensions';
    const before = yaml.load(fs.readFileSync(file, 'utf8'));
    const deliver = { human: 'interrupt', agent: 'after_turn', from: { 甲: 'interrupt' } };

    // 别人 403，盘上没动
    const o = await request(port, P, { method: 'PUT', token: other, body: { 'dev.sameroof.deliver': deliver } });
    assert.equal(o.status, 403); assert.equal(o.body.error.code, 'ROOM-FORBIDDEN');
    assert.deepEqual(yaml.load(fs.readFileSync(file, 'utf8')), before);

    // 本人 200：deliver 加上，limits / routines 原样；yaml 里除 extensions 外一字不变；中文没被转义
    const s = await request(port, P, { method: 'PUT', token: self, body: { 'dev.sameroof.deliver': deliver } });
    assert.equal(s.status, 200);
    assert.deepEqual(s.body, { id: 'resident_beta_01', extensions: { ...before.extensions, 'dev.sameroof.deliver': deliver }, note: '适配器重启后生效' });
    const text1 = fs.readFileSync(file, 'utf8'); const after1 = yaml.load(text1);
    assert.deepEqual(strip(after1), strip(before));
    assert.deepEqual(after1.extensions, s.body.extensions);
    assert.ok(text1.includes('甲: interrupt') && text1.includes('prompt: 早安') && text1.includes('emoji: 🌸'), '中文与 emoji 原样写回');
    assert.ok(!fs.existsSync(file + '.tmp'));

    // 整段替换：deliver 换成只剩 human，from 不会残留
    const s2 = await request(port, P, { method: 'PUT', token: human, body: { 'dev.sameroof.deliver': { human: 'inject' } } });
    assert.equal(s2.status, 200); assert.deepEqual(s2.body.extensions['dev.sameroof.deliver'], { human: 'inject' });
    assert.deepEqual(yaml.load(fs.readFileSync(file, 'utf8')).extensions['dev.sameroof.limits'], { agent_hops: 3 });

    // GET /rooms/:id 读得到现值（本人 / 人都行）
    const g = await request(port, '/rooms/resident_beta_01', { token: self });
    assert.equal(g.status, 200); assert.deepEqual(g.body.extensions, s2.body.extensions);
    assert.deepEqual((await request(port, '/rooms/' + encodeURIComponent('乙'), { token: human })).body.extensions, s2.body.extensions);

    // null 删段：routines 没了，其它还在；数组也能整段替换
    const d = await request(port, P, { method: 'PUT', token: self, body: { 'dev.sameroof.routines': null, 'dev.sameroof.limits': null } });
    assert.equal(d.status, 200); assert.deepEqual(Object.keys(d.body.extensions).sort(), ['dev.sameroof.deliver']);
    assert.deepEqual(yaml.load(fs.readFileSync(file, 'utf8')).extensions, { 'dev.sameroof.deliver': { human: 'inject' } });
    const arr = await request(port, P, { method: 'PUT', token: self, body: { 'dev.sameroof.routines': [{ id: 'noon', cron: '0 12 * * *', prompt: '午安' }] } });
    assert.equal(arr.status, 200); assert.equal(arr.body.extensions['dev.sameroof.routines'][0].id, 'noon');
    // 全删光：extensions 键整个拿掉，GET 回 {}
    assert.equal((await request(port, P, { method: 'PUT', token: self, body: { 'dev.sameroof.routines': null, 'dev.sameroof.deliver': null } })).status, 200);
    assert.ok(!Object.hasOwn(yaml.load(fs.readFileSync(file, 'utf8')), 'extensions'));
    assert.deepEqual((await request(port, '/rooms/resident_beta_01', { token: self })).body.extensions, {});

    // 非法 namespace 400：不是我们前缀 / 只有两段 / 大写 / 空 body / 值是字符串
    for (const body of [{ 'com.example.x': {} }, { 'dev.sameroof': {} }, { 'dev.sameroof.Deliver': {} }, { 'dev.sameroof.deliver.': {} }]) {
      const bad = await request(port, P, { method: 'PUT', token: human, body });
      assert.equal(bad.status, 400, JSON.stringify(body)); assert.equal(bad.body.error.code, 'ROOM-EXT-NAMESPACE');
    }
    assert.equal((await request(port, P, { method: 'PUT', token: human, body: {} })).body.error.code, 'ROOM-EXT-INVALID');
    assert.equal((await request(port, P, { method: 'PUT', token: human, body: { 'dev.sameroof.deliver': 'interrupt' } })).body.error.code, 'ROOM-EXT-INVALID');
    assert.equal((await request(port, P, { method: 'PUT', token: human, body: [1] })).body.error.code, 'ROOM-EXT-INVALID');

    // schema 不过 → 400 带 issues，不写盘、不留 .tmp：把乙的 room.yaml 先弄成 schema 过不了的（多个不认识的核心字段），再 PUT
    const snapshot = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, snapshot + 'nonsense_field: 1\n');
    const broken = fs.readFileSync(file, 'utf8');
    const inv = await request(port, P, { method: 'PUT', token: human, body: { 'dev.sameroof.deliver': { human: 'interrupt' } } });
    assert.equal(inv.status, 400); assert.equal(inv.body.error.code, 'ROOM-EXT-INVALID');
    assert.ok(Array.isArray(inv.body.error.issues) && inv.body.error.issues.some(i => i.code === 'ROOM-UNKNOWN-001'));
    assert.ok(inv.body.error.issues.every(i => i.file === file && !i.file.endsWith('.tmp')));
    assert.equal(fs.readFileSync(file, 'utf8'), broken);
    assert.ok(!fs.existsSync(file + '.tmp'));
    assert.deepEqual((await request(port, '/rooms/resident_beta_01', { token: self })).body.extensions, {}, '内存里也没被改');
    fs.writeFileSync(file, snapshot);

    // 没这间屋 404；其它方法照旧（POST /rooms/:id/extensions 不是门）
    assert.equal((await request(port, '/rooms/resident_nobody_01/extensions', { method: 'PUT', token: human, body: { 'dev.sameroof.deliver': {} } })).status, 404);
    assert.equal((await request(port, P, { method: 'POST', token: human, body: { 'dev.sameroof.deliver': {} } })).status, 404);

    // 活动流里有 config_change
    const acts = await request(port, '/activity', { token: human });
    const cc = acts.body.filter(x => x.kind === 'config_change' && x.meta && x.meta.room_id === 'resident_beta_01');
    assert.ok(cc.length >= 5); assert.ok(cc.some(x => x.meta.deleted.includes('dev.sameroof.routines')));
  } finally {
    await room.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
