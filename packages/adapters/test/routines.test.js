'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { mergeRoutines, dueNow, countMissed, LANE } = require('../lib/room');

const ext = list => ({ extensions: { 'dev.sameroof.routines': list } });

test('车道优先级：人 > 例行 > agent > 心跳', () => {
  assert.ok(LANE.human > LANE.routine && LANE.routine > LANE.agent && LANE.agent > LANE.heartbeat);
});
test('合并：房子在前、房间追加、同 id 房间覆盖；默认 enabled=true、quiet_hours=ignore', () => {
  const house = ext([{ id: 'a', cron: '0 9 * * *', prompt: '房子的 a' }, { id: 'b', cron: '0 10 * * *', prompt: '房子的 b', enabled: false }]);
  const room = ext([{ id: 'b', cron: '30 10 * * *', prompt: '房间的 b', quiet_hours: 'respect' }, { id: 'c', cron: '* * * * *', prompt: '  c  ' }]);
  const out = mergeRoutines(house, room);
  assert.deepEqual(out.map(r => r.id), ['a', 'b', 'c']);
  assert.deepEqual(out[0], { id: 'a', cron: '0 9 * * *', prompt: '房子的 a', enabled: true, quiet_hours: 'ignore' });
  assert.deepEqual(out[1], { id: 'b', cron: '30 10 * * *', prompt: '房间的 b', enabled: true, quiet_hours: 'respect' });
  assert.equal(out[2].prompt, 'c');
  assert.deepEqual(mergeRoutines({}, {}), []);
  assert.deepEqual(mergeRoutines({ extensions: {} }, null), []);
});
test('合并：缺 id/prompt、cron 非法、同一处 id 重复都抛', () => {
  assert.throws(() => mergeRoutines(ext([{ cron: '* * * * *', prompt: 'x' }]), {}), /缺 id/);
  assert.throws(() => mergeRoutines({}, ext([{ id: 'x', cron: '* * * * *' }])), /缺 prompt/);
  assert.throws(() => mergeRoutines({}, ext([{ id: 'x', cron: '99 * * * *', prompt: 'p' }])), /99 \* \* \* \*/);
  assert.throws(() => mergeRoutines(ext([{ id: 'x', cron: '* * * * *', prompt: 'p' }, { id: 'x', cron: '* * * * *', prompt: 'q' }]), {}), /重复/);
  assert.throws(() => mergeRoutines({ extensions: { 'dev.sameroof.routines': {} } }, {}), /数组/);
});
test('dueNow：同一分钟不重复触发，下一分钟可以', () => {
  const r = { id: 'm', cron: '* * * * *', prompt: 'p', enabled: true, quiet_hours: 'ignore' };
  const t = new Date('2026-09-07T00:30:10Z');
  assert.equal(dueNow(r, {}, t, 'Asia/Shanghai'), '2026-09-07T08:30');
  const state = { routines: { m: { last_fired: '2026-09-07T08:30' } } };
  assert.equal(dueNow(r, state, t, 'Asia/Shanghai'), null);
  assert.equal(dueNow(r, state, new Date('2026-09-07T00:30:50Z'), 'Asia/Shanghai'), null);   // 同一分钟内第二次 tick
  assert.equal(dueNow(r, state, new Date('2026-09-07T00:31:05Z'), 'Asia/Shanghai'), '2026-09-07T08:31');
  assert.equal(dueNow({ ...r, enabled: false }, {}, t, 'Asia/Shanghai'), null);
  assert.equal(dueNow({ ...r, cron: '0 9 * * *' }, {}, t, 'Asia/Shanghai'), null);           // 没到点
  assert.equal(dueNow({ ...r, cron: '30 8 * * *' }, {}, t, 'Asia/Shanghai'), '2026-09-07T08:30');
});
test('countMissed：上次触发之后、这一分钟之前错过的次数', () => {
  const r = { id: 'q', cron: '*/15 * * * *', prompt: 'p', enabled: true };
  const now = new Date('2026-09-07T02:00:30Z');                                   // 上海 10:00
  assert.equal(countMissed(r, {}, now, 'Asia/Shanghai'), 0);                       // 从没触发过，不算
  assert.equal(countMissed(r, { routines: { q: { last_fired: '2026-09-07T09:00' } } }, now, 'Asia/Shanghai'), 3);   // 09:15 09:30 09:45；10:00 是当前分钟，由 tick 触发
  assert.equal(countMissed(r, { routines: { q: { last_fired: '2026-09-07T09:45' } } }, now, 'Asia/Shanghai'), 0);
  assert.equal(countMissed(r, { routines: { q: { last_fired: '2026-09-07T09:00' } } }, now, 'Asia/Shanghai', 20), 1);  // 封顶只往回看 20 分钟
});

// ---- W1.1：一次性 at ----
const atR = (over = {}) => mergeRoutines({}, ext([{ id: 'once', at: '2026-09-08T21:00:00+08:00', prompt: '提醒维护者吃药', ...over }]), 'Asia/Shanghai')[0];

test('at：解析成 UTC ISO，默认 late_grace=24h；数字按分钟、字符串带单位', () => {
  const r = atR();
  assert.equal(r.at, '2026-09-08T13:00:00.000Z');
  assert.equal(r.at_ms, Date.parse('2026-09-08T13:00:00Z'));
  assert.equal(r.late_grace_ms, 24 * 3600000);
  assert.equal(r.cron, undefined);
  assert.deepEqual({ enabled: r.enabled, quiet_hours: r.quiet_hours, prompt: r.prompt }, { enabled: true, quiet_hours: 'ignore', prompt: '提醒维护者吃药' });
  assert.equal(atR({ late_grace: '90m' }).late_grace_ms, 90 * 60000);
  assert.equal(atR({ late_grace: '2d' }).late_grace_ms, 2 * 86400000);
  assert.equal(atR({ late_grace: 30 }).late_grace_ms, 30 * 60000);
  assert.equal(atR({ at: '2026-09-08T13:00Z' }).at, '2026-09-08T13:00:00.000Z');
  assert.equal(atR({ at: '2026-09-08T21:00+0800' }).at, '2026-09-08T13:00:00.000Z');
});
test('at：不带时区按房子 tz 解释（Asia/Shanghai），只给日期按当天 00:00', () => {
  assert.equal(atR({ at: '2026-09-08T21:00' }).at, '2026-09-08T13:00:00.000Z');
  assert.equal(atR({ at: '2026-09-08 21:00:30' }).at, '2026-09-08T13:00:30.000Z');
  assert.equal(atR({ at: '2026-09-08' }).at, '2026-09-07T16:00:00.000Z');
  assert.equal(mergeRoutines({}, ext([{ id: 'x', at: '2026-09-08T21:00', prompt: 'p' }]), 'UTC')[0].at, '2026-09-08T21:00:00.000Z');
  // 夏令时也交给 Intl：纽约 2026-07-04 12:00 = UTC 16:00（EDT）
  assert.equal(mergeRoutines({}, ext([{ id: 'x', at: '2026-07-04T12:00', prompt: 'p' }]), 'America/New_York')[0].at, '2026-07-04T16:00:00.000Z');
});
test('at：cron 与 at 同给、都不给、at 解析不了、late_grace 看不懂、cron 型带 late_grace 都抛', () => {
  assert.throws(() => mergeRoutines({}, ext([{ id: 'x', cron: '* * * * *', at: '2026-09-08T21:00Z', prompt: 'p' }])), /二选一.*两个都给了/);
  assert.throws(() => mergeRoutines({}, ext([{ id: 'x', prompt: 'p' }])), /二选一.*一个都没给/);
  assert.throws(() => atR({ at: '明天晚上' }), /at 看不懂/);
  assert.throws(() => atR({ at: '2026-09-08T25:99' }), /at 看不懂/);
  assert.throws(() => atR({ at: 20260908 }), /ISO 8601/);
  assert.throws(() => atR({ late_grace: 'soon' }), /late_grace 看不懂/);
  assert.throws(() => mergeRoutines({}, ext([{ id: 'x', cron: '* * * * *', prompt: 'p', late_grace: '1h' }])), /late_grace 只对 at 型/);
});
test('dueNow（at）：未到不触发；到点触发一次、键是 at 的 ISO；state 记 done 后永不再触发；enabled=false 不触发', () => {
  const r = atR();
  assert.equal(dueNow(r, {}, new Date('2026-09-08T12:59:59Z'), 'Asia/Shanghai'), null);
  assert.equal(dueNow(r, {}, new Date('2026-09-08T13:00:00Z'), 'Asia/Shanghai'), '2026-09-08T13:00:00.000Z');
  assert.equal(dueNow(r, {}, new Date('2026-09-08T13:00:20Z'), 'Asia/Shanghai'), '2026-09-08T13:00:00.000Z');   // 触发前再 tick 一次仍是 due（由 tick 记 done）
  const fired = { routines: { once: { last_fired: '2026-09-08T13:00:00.000Z', fired: 1, done: true, fired_at: '2026-09-08T13:00:05.000Z' } } };
  assert.equal(dueNow(r, fired, new Date('2026-09-08T13:00:40Z'), 'Asia/Shanghai'), null);
  assert.equal(dueNow(r, fired, new Date('2026-09-09T13:00:00Z'), 'Asia/Shanghai'), null);
  assert.equal(dueNow(r, fired, new Date('2027-01-01T00:00:00Z'), 'Asia/Shanghai'), null);
  assert.equal(dueNow({ ...r, enabled: false }, {}, new Date('2026-09-08T13:00:00Z'), 'Asia/Shanghai'), null);
});
test('dueNow/countMissed（at）：错过在 late_grace 内启动补跑，超过就不补、countMissed 记 1', () => {
  const r = atR();                                                                  // grace 24h
  assert.equal(dueNow(r, {}, new Date('2026-09-08T18:00:00Z'), 'Asia/Shanghai'), r.at);       // 晚 5h，补
  assert.equal(countMissed(r, {}, new Date('2026-09-08T18:00:00Z'), 'Asia/Shanghai'), 0);
  assert.equal(dueNow(r, {}, new Date('2026-09-09T12:59:00Z'), 'Asia/Shanghai'), r.at);       // 晚 23h59m，还补
  assert.equal(dueNow(r, {}, new Date('2026-09-09T13:00:01Z'), 'Asia/Shanghai'), null);       // 晚过 24h，不补
  assert.equal(countMissed(r, {}, new Date('2026-09-09T13:00:01Z'), 'Asia/Shanghai'), 1);
  assert.equal(countMissed(r, {}, new Date('2026-09-08T12:00:00Z'), 'Asia/Shanghai'), 0);     // 还没到，不算错过
  const short = atR({ late_grace: '10m' });
  assert.equal(dueNow(short, {}, new Date('2026-09-08T13:09:00Z'), 'Asia/Shanghai'), short.at);
  assert.equal(dueNow(short, {}, new Date('2026-09-08T13:11:00Z'), 'Asia/Shanghai'), null);
  assert.equal(countMissed(short, {}, new Date('2026-09-08T13:11:00Z'), 'Asia/Shanghai'), 1);
  const done = { routines: { once: { done: true } } };
  assert.equal(countMissed(r, done, new Date('2026-09-20T00:00:00Z'), 'Asia/Shanghai'), 0);   // 响过的不算错过
  assert.equal(countMissed({ ...r, enabled: false }, {}, new Date('2026-09-20T00:00:00Z'), 'Asia/Shanghai'), 0);
});
test('合并：cron 型输出形状不变，at 型房间覆盖房子', () => {
  const house = ext([{ id: 'a', cron: '0 9 * * *', prompt: 'A' }, { id: 'o', at: '2026-09-08T21:00+08:00', prompt: '房子的' }]);
  const room = ext([{ id: 'o', at: '2026-09-09T21:00+08:00', prompt: '房间的' }]);
  const out = mergeRoutines(house, room, 'Asia/Shanghai');
  assert.deepEqual(out[0], { id: 'a', cron: '0 9 * * *', prompt: 'A', enabled: true, quiet_hours: 'ignore' });
  assert.equal(out[1].at, '2026-09-09T13:00:00.000Z'); assert.equal(out[1].prompt, '房间的');
});
