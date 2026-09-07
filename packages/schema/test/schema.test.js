'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateRoom, validateHouse, normalizeName, resolveExecutionConfig } = require('..');

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
  context: {recent_messages: 20, recent_max_chars: 4000, memory_hits: 4, memory_recent: 3}
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
context: {recent_messages: 8, memory_hits: 2}
avatar: {emoji: "🌊"}
`,
      维护者: `schema_version: 1
id: resident_operator_01
name: 维护者
species: human
notify: {channel: push}
avatar: {emoji: "🦉"}
`
    }
  });
  assert.deepEqual(validateHouse(dir), []);
});

test('context 有明确整数边界且不接受拼错字段', () => {
  const dir = makeHouse({ house: validHouse, rooms: {
    a: `schema_version: 1
id: resident_agent_01
name: 小甲
model: {provider: zhipu, id: one, auth: {mode: broker, credential: shared-cheap}}
context: {recent_messages: -1, memory_hit: 3}
`
  }});
  const issues = validateHouse(dir);
  assert.ok(issues.some(x => x.code === 'ROOM-SCHEMA-001'));
  assert.ok(issues.some(x => x.code === 'ROOM-UNKNOWN-001'));
});

test('avatar image 只能指向本房间内已存在的相对文件', () => {
  const dir = makeHouse({ house: validHouse, rooms: {
    a: `schema_version: 1
id: resident_agent_01
name: 小甲
model: {provider: zhipu, id: one, auth: {mode: broker, credential: shared-cheap}}
avatar: {image: missing.png}
`
  }});
  assert.ok(validateHouse(dir).some(x => x.code === 'ROOM-AVATAR-IMAGE-001'));
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

test('deliver / limits / routines 是房子与房间的核心字段', () => {
  const house = validHouse
    .replace('  approve_timeout: 30m', `  deliver: {human: after_turn, agent: inject, from: {维护者: interrupt}}
  limits: {run_timeout_ms: 180000, agent_hops: 6}
  approve_timeout: 30m`)
    .replace('notify: {admin: 维护者}', `notify: {admin: 维护者}
routines:
  - {id: morning, cron: "30 9 * * 1-5", prompt: 看交接信}`);
  const dir = makeHouse({ house, rooms: {
    a: `schema_version: 1
id: resident_agent_01
name: 小甲
model: {provider: zhipu, id: one, auth: {mode: broker, credential: shared-cheap}}
deliver: {agent: after_turn}
limits: {agent_hops: 2}
routines:
  - {id: morning, cron: "0 10 * * *", prompt: 房间覆盖}
  - {id: noon, cron: "0 12 * * *", prompt: 午安, quiet_hours: respect}
`
  }});
  assert.deepEqual(validateHouse(dir), []);
});

test('核心运行字段拒绝错误模式、越界限制、重复 id 与非法 cron', () => {
  const house = validHouse.replace('  approve_timeout: 30m', `  deliver: {human: wake}
  limits: {run_timeout_ms: 999, agent_hops: 100}
  approve_timeout: 30m`);
  const dir = makeHouse({ house, rooms: {
    a: `schema_version: 1
id: resident_agent_01
name: 小甲
model: {provider: zhipu, id: one, auth: {mode: broker, credential: shared-cheap}}
routines:
  - {id: bad, cron: "99 * * * *", prompt: x}
  - {id: bad, cron: "* * * * *", prompt: " "}
`
  }});
  const issues = validateHouse(dir);
  assert.ok(issues.some(x => x.code === 'HOUSE-SCHEMA-001'));
  assert.ok(issues.some(x => x.code === 'ROOM-ROUTINE-ID-DUP-001'));
  assert.ok(issues.some(x => x.code === 'ROOM-ROUTINE-CRON-001'));
  assert.ok(issues.some(x => x.code === 'ROOM-ROUTINE-PROMPT-001'));
});

test('legacy routines extension 仍校验；human 不能配 routines', () => {
  const dir = makeHouse({ house: validHouse, rooms: {
    a: `schema_version: 1
id: resident_agent_01
name: 小甲
model: {provider: zhipu, id: one, auth: {mode: broker, credential: shared-cheap}}
extensions:
  dev.sameroof.routines:
    - {id: old, cron: "* *", prompt: x}
`,
    h: `schema_version: 1
id: resident_human_01
name: 小乙
species: human
routines:
  - {id: noon, cron: "0 12 * * *", prompt: x}
`
  }});
  const issues = validateHouse(dir);
  assert.ok(issues.some(x => x.code === 'ROOM-ROUTINE-CRON-001'));
  assert.ok(issues.some(x => x.code === 'ROOM-HUMAN-001'));
});

test('运行配置解析：核心优先、extension 回退，房间覆盖房子', () => {
  const house = {
    defaults: {
      deliver: { human: 'after_turn', agent: 'inject', from: { 甲: 'interrupt' } },
      limits: { run_timeout_ms: 120000, agent_hops: 5 }
    },
    extensions: {
      'dev.sameroof.deliver': { human: 'inject' },
      'dev.sameroof.limits': { agent_hops: 9 },
      'dev.sameroof.routines': [{ id: 'old', cron: '* * * * *', prompt: '旧入口' }]
    },
    routines: [{ id: 'a', cron: '0 9 * * *', prompt: '房子 a' }]
  };
  const room = {
    deliver: { agent: 'after_turn', from: { 甲: 'after_turn' } },
    limits: { agent_hops: 2 },
    routines: [{ id: 'a', cron: '30 9 * * *', prompt: ' 房间 a ' }, { id: 'b', cron: '0 12 * * *', prompt: 'b', enabled: false }]
  };
  assert.deepEqual(resolveExecutionConfig(house, room), {
    deliver: { human: 'after_turn', agent: 'after_turn', from: { 甲: 'after_turn' } },
    limits: { run_timeout_ms: 120000, agent_hops: 2 },
    routines: [
      { id: 'a', cron: '30 9 * * *', prompt: '房间 a', enabled: true, quiet_hours: 'ignore' },
      { id: 'b', cron: '0 12 * * *', prompt: 'b', enabled: false, quiet_hours: 'ignore' }
    ]
  });
});
