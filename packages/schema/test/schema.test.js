'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateRoom, validateHouse, normalizeName } = require('..');

function makeHouse({ house, rooms }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-schema-'));
  fs.mkdirSync(path.join(dir, 'rooms'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'house.yaml'), house);
  for (const [name, yaml] of Object.entries(rooms)) {
    const roomDir = path.join(dir, 'rooms', name);
    fs.mkdirSync(roomDir);
    fs.writeFileSync(path.join(roomDir, 'room.yaml'), yaml);
  }
  return dir;
}

const validHouse = `
schema_version: 1
name: 测试小家
timezone: Asia/Shanghai
defaults:
  runtime: pi
  plugins: [memory, handover, living-room]
  heartbeat:
    enabled: true
    mode: minimal
    interval: adaptive
    budget: {per_day: {requests: 12, tokens: 50000}, on_exceeded: passive}
  approve_timeout: 30m
  permissions:
    core.exec: approve
    living_room.send: allow
credentials:
  - {alias: shared-cheap, provider: zhipu, purpose: 测试}
notify: {admin: 维护者}
`;

test('名字规范化使用 NFKC、大小写与空白折叠', () => {
  assert.equal(normalizeName('  Ｐｌａｎｎｅｒ  HOME '), 'planner home');
});

test('合法 agent 与 human 房间通过', () => {
  const dir = makeHouse({
    house: validHouse,
    rooms: {
      检索员: `schema_version: 1
id: resident_researcher_01
name: 检索员
model: {provider: zhipu, id: glm-test, auth: {mode: broker, credential: shared-cheap}}
`,
      维护者: `schema_version: 1
id: resident_operator_01
name: 维护者
species: human
notify: {channel: push}
`
    }
  });
  assert.deepEqual(validateHouse(dir), []);
});

test('human 房间不能带 model，并给稳定人话错误码', () => {
  const dir = makeHouse({
    house: validHouse,
    rooms: {
      维护者: `schema_version: 1
id: resident_operator_01
name: 维护者
species: human
model: {provider: x, id: y, auth: {mode: broker, credential: shared-cheap}}
`
    }
  });
  const file = path.join(dir, 'rooms', '维护者', 'room.yaml');
  const issues = validateRoom(file);
  assert.ok(issues.some(x => x.code === 'ROOM-HUMAN-001' && x.line === 5));
});

test('全屋检查拒绝重复 id、规范化重名和未知凭证', () => {
  const dir = makeHouse({
    house: validHouse,
    rooms: {
      a: `schema_version: 1
id: resident_same_01
name: planner
model: {provider: zhipu, id: one, auth: {mode: broker, credential: missing}}
`,
      b: `schema_version: 1
id: resident_same_01
name: ＰＬＡＮＮＥＲ
model: {provider: zhipu, id: two, auth: {mode: broker, credential: shared-cheap}}
`
    }
  });
  const codes = new Set(validateHouse(dir).map(x => x.code));
  assert.ok(codes.has('ROOM-ID-DUP-001'));
  assert.ok(codes.has('ROOM-NAME-DUP-001'));
  assert.ok(codes.has('CRED-ALIAS-001'));
});

test('runtime_managed 别名按 house 声明校验但不交给 broker', () => {
  const house = validHouse.replace(
    '  - {alias: shared-cheap, provider: zhipu, purpose: 测试}',
    '  - {alias: shared-cheap, provider: zhipu, purpose: 测试}\n  - {alias: claude-max, provider: claude-code, mode: runtime_managed, purpose: 测试}'
  );
  const dir = makeHouse({ house, rooms: {
    a: `schema_version: 1\nid: resident_agent_01\nname: 规划员\nmodel: {provider: claude-code, id: opus, auth: {mode: runtime_managed, credential: claude-max}}\n`
  }});
  assert.deepEqual(validateHouse(dir), []);
});

test('房间权限不能超过 house 上限', () => {
  const dir = makeHouse({
    house: validHouse,
    rooms: {
      a: `schema_version: 1
id: resident_agent_01
name: 小甲
model: {provider: zhipu, id: one, auth: {mode: broker, credential: shared-cheap}}
permissions:
  core.exec: allow
`
    }
  });
  assert.ok(validateHouse(dir).some(x => x.code === 'ROOM-PERM-CEILING-001'));
});
