'use strict';
// RFC 2026-09-15-gateway-allow §2.1 — effective permission = min(rank(house), rank(room)); room may tighten, never widen.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createGateway } = require('../server');
const { validateHouse, PERMISSION_RANK } = require('@sameroof/schema');

const house = perms => `schema_version: 1
name: ceiling-test
timezone: UTC
defaults:
  runtime: test
  plugins: []
  heartbeat: {}
  context: {recent_messages: 0, recent_max_chars: 0, memory_hits: 0, memory_recent: 0}
  approve_timeout: 1m
  permissions:
${Object.entries(perms).map(([k, v]) => `    ${k}: ${v}`).join('\n')}
credentials: []
notify: {admin: 甲}
`;
const room = (id, name, perms = {}) => `schema_version: 1\nid: ${id}\nname: ${name}\nspecies: human\n` +
  (Object.keys(perms).length ? 'permissions:\n' + Object.entries(perms).map(([k, v]) => `  ${k}: ${v}`).join('\n') + '\n' : '');

function fixture(housePerms, roomPerms) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-ceiling-'));
  fs.mkdirSync(path.join(root, 'rooms', '甲'), { recursive: true });
  fs.writeFileSync(path.join(root, 'rooms', '甲', 'room.yaml'), room('resident_alpha_01', '甲', roomPerms));
  fs.writeFileSync(path.join(root, 'house.yaml'), house(housePerms));
  const gateway = createGateway({ houseDir: root, runDir: path.join(root, 'run'), stateDir: path.join(root, 'state'), bwrapProbe: false, lockRequired: false, resultClient: async () => {} });
  return { root, gateway, close: async () => { await gateway.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('PERMISSION_RANK is exported and ordered deny < approve < allow', () => {
  assert.equal(PERMISSION_RANK.deny, 0); assert.equal(PERMISSION_RANK.approve, 1); assert.equal(PERMISSION_RANK.allow, 2);
});

const cases = [
  // house, room,      expected effective   (matrix rows 1-4 of the RFC)
  ['allow',   undefined, 'allow'],
  ['allow',   'approve', 'approve'],  // room tightens
  ['allow',   'deny',    'deny'],     // room tightens to deny
  ['approve', 'allow',   'approve'],  // room may NOT widen — this is the bug being fixed
  ['approve', undefined, 'approve'],
  ['deny',    'allow',   'deny'],     // ceiling wins
  [undefined, 'allow',   'deny'],     // missing ceiling → deny
  ['allow',   'bogus',   'deny'],     // unknown room value → fail closed
];
for (const [h, r, expected] of cases) {
  test(`effectivePermission(house=${h ?? '∅'}, room=${r ?? '∅'}) → ${expected}`, async () => {
    const f = fixture(h === undefined ? {} : { 'core.fs.read': h }, r === undefined ? {} : { 'core.fs.read': r });
    try {
      assert.equal(f.gateway.effectivePermission('core.fs.read', 'resident_alpha_01'), expected);
      if (expected === 'deny') assert.throws(() => f.gateway.ensurePermission('core.fs.read', 'resident_alpha_01'), e => e.code === 'GW-POLICY-DENIED');
      else assert.equal(f.gateway.ensurePermission('core.fs.read', 'resident_alpha_01'), expected);
    } finally { await f.close(); }
  });
}

test('schema regression: room value above house ceiling is ROOM-PERM-CEILING-001 at validate time', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-ceiling-schema-'));
  fs.mkdirSync(path.join(root, 'rooms', '甲'), { recursive: true });
  fs.writeFileSync(path.join(root, 'rooms', '甲', 'room.yaml'), room('resident_alpha_01', '甲', { 'core.fs.read': 'allow' }));
  fs.writeFileSync(path.join(root, 'house.yaml'), house({ 'core.fs.read': 'approve' }));
  const issues = validateHouse(root);
  assert.ok(issues.some(i => i.code === 'ROOM-PERM-CEILING-001'), 'expected ROOM-PERM-CEILING-001, got ' + JSON.stringify(issues.map(i => i.code)));
  fs.rmSync(root, { recursive: true, force: true });
});
