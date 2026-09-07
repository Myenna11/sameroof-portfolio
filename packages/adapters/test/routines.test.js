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
