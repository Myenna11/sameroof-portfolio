'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { parse, matches, parts } = require('../lib/cron');

const at = iso => new Date(iso);   // 2026-09-07 是周一

test('星号：每分钟都匹配', () => {
  assert.equal(matches('* * * * *', at('2026-09-07T03:14:00Z'), 'UTC'), true);
});
test('数字、列表、区间', () => {
  assert.equal(matches('30 9 * * *', at('2026-09-07T09:30:00Z'), 'UTC'), true);
  assert.equal(matches('30 9 * * *', at('2026-09-07T09:31:00Z'), 'UTC'), false);
  assert.equal(matches('0,15,45 * * * *', at('2026-09-07T09:45:00Z'), 'UTC'), true);
  assert.equal(matches('0,15,45 * * * *', at('2026-09-07T09:30:00Z'), 'UTC'), false);
  assert.equal(matches('0 9-17 * * *', at('2026-09-07T17:00:00Z'), 'UTC'), true);
  assert.equal(matches('0 9-17 * * *', at('2026-09-07T18:00:00Z'), 'UTC'), false);
});
test('步长：*/15 与 1-30/5', () => {
  assert.deepEqual([...parse('*/15 * * * *').fields[0]], [0, 15, 30, 45]);
  assert.deepEqual([...parse('1-30/5 * * * *').fields[0]], [1, 6, 11, 16, 21, 26]);
  assert.equal(matches('*/15 * * * *', at('2026-09-07T09:45:00Z'), 'UTC'), true);
  assert.equal(matches('*/15 * * * *', at('2026-09-07T09:50:00Z'), 'UTC'), false);
});
test('周：0 和 7 都是周日', () => {
  const sun = at('2026-09-06T10:00:00Z');
  assert.equal(matches('0 10 * * 0', sun, 'UTC'), true);
  assert.equal(matches('0 10 * * 7', sun, 'UTC'), true);
  assert.equal(matches('0 10 * * 1-5', sun, 'UTC'), false);
  assert.equal(matches('0 10 * * 1-5', at('2026-09-07T10:00:00Z'), 'UTC'), true);
});
test('日和周都写了限制：任一匹配', () => {
  // 2026-09-07 周一、7 号；15 号是周二
  assert.equal(matches('0 0 15 * 1', at('2026-09-07T00:00:00Z'), 'UTC'), true);   // 周对上
  assert.equal(matches('0 0 15 * 1', at('2026-09-15T00:00:00Z'), 'UTC'), true);   // 日对上
  assert.equal(matches('0 0 15 * 1', at('2026-09-08T00:00:00Z'), 'UTC'), false);
  assert.equal(matches('0 0 15 * *', at('2026-09-07T00:00:00Z'), 'UTC'), false);  // 只写日就得日对上
});
test('非法表达式抛错，错误里带原文', () => {
  for (const bad of ['60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '* * * *', 'a * * * *', '5-1 * * * *', '*/0 * * * *']) {
    assert.throws(() => parse(bad), e => e.message.includes(bad), bad);
  }
  assert.throws(() => parse(42), /不是字符串/);
});
test('时区：同一 UTC 时刻在 Asia/Shanghai 与 UTC 下小时不同', () => {
  const d = at('2026-09-07T00:30:00Z');
  assert.equal(parts(d, 'UTC').hour, 0);
  assert.equal(parts(d, 'Asia/Shanghai').hour, 8);
  assert.equal(matches('30 8 * * *', d, 'Asia/Shanghai'), true);
  assert.equal(matches('30 8 * * *', d, 'UTC'), false);
  assert.equal(matches('30 0 * * *', d, 'UTC'), true);
  // 跨日：上海已经是 8 号周二
  const e = at('2026-09-07T16:30:00Z');
  assert.deepEqual([parts(e, 'Asia/Shanghai').day, parts(e, 'Asia/Shanghai').dow, parts(e, 'Asia/Shanghai').key], [8, 2, '2026-09-08T00:30']);
  assert.equal(parts(e, 'UTC').key, '2026-09-07T16:30');
});
