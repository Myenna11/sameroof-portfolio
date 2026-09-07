'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs'), os = require('os'), path = require('path');
const { resolveHouseRoot, findUp } = require('..');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-root-'));
const withHouse = dir => { fs.writeFileSync(path.join(dir, 'house.yaml'), 'name: t\n'); return dir; };
const real = p => fs.realpathSync(p);

test('1. SAMEROOF_ROOT 优先：指向的目录必须有 house.yaml', () => {
  const root = withHouse(tmp()), other = withHouse(tmp());
  assert.equal(resolveHouseRoot(other, { SAMEROOF_ROOT: root }), path.resolve(root));   // env 赢过 cwd
  const empty = tmp();
  assert.throws(() => resolveHouseRoot(other, { SAMEROOF_ROOT: empty }), /SAMEROOF_ROOT=.*没有 house\.yaml/);
});
test('2. 从 cwd 向上逐级找 house.yaml', () => {
  const root = withHouse(tmp());
  const deep = path.join(root, 'packages', 'adapters', 'pi'); fs.mkdirSync(deep, { recursive: true });
  assert.equal(real(resolveHouseRoot(deep, {})), real(root));
  assert.equal(real(resolveHouseRoot(root, {})), real(root));
  assert.equal(findUp(tmp()), null);
});
test('3. 兜底 ~/.sameroof（认 HOME）', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.sameroof'), { recursive: true }); withHouse(path.join(home, '.sameroof'));
  assert.equal(real(resolveHouseRoot(tmp(), { HOME: home })), real(path.join(home, '.sameroof')));
});
test('4. 三条路都没有：抛错并把三条路写清楚', () => {
  const home = tmp(), start = tmp();
  assert.throws(() => resolveHouseRoot(start, { HOME: home }), err => {
    assert.match(err.message, /SAMEROOF_ROOT/); assert.ok(err.message.includes(path.resolve(start))); assert.ok(err.message.includes(path.join(home, '.sameroof')));
    return true;
  });
});
test('5. 旧名 SAMEROOF_HOUSE 不再认（不留兼容期）：只设它等于没设', () => {
  const a = withHouse(tmp());
  assert.throws(() => resolveHouseRoot(tmp(), { SAMEROOF_HOUSE: a, HOME: tmp() }), /找不到房子/);
});
