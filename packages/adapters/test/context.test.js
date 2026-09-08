'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { scoreRecent, renderFrame, frameBody, pickRecent, isTool, toolName } = require('../lib/context');

const ME = 'r_me';
const NOW = Date.parse('2026-09-07T12:00:00Z');
const members = [{ id: 'h1', name: '维护者', species: 'human' }, { id: 'a1', name: '实现员', species: 'agent' }, { id: ME, name: '我', species: 'agent' }];
const msg = (o = {}) => Object.assign({ id: 'm', ts: '2026-09-07T11:50:00Z', kind: 'say', from_id: 'a1', text: '嗯', mentions: [], meta: null }, o);
const base = { roomId: ME, inbox: [], members, now: NOW };

test('scoreRecent：基线 0；@ 了我 +3', () => {
  assert.equal(scoreRecent(msg(), base), 0);
  assert.equal(scoreRecent(msg({ mentions: [ME] }), base), 3);
});
test('scoreRecent：我自己说的 +2', () => { assert.equal(scoreRecent(msg({ from_id: ME }), base), 2); });
test('scoreRecent：发言人在本次 inbox 里 +2', () => { assert.equal(scoreRecent(msg(), { ...base, inbox: [{ from_id: 'a1' }] }), 2); });
test('scoreRecent：人类 +1', () => { assert.equal(scoreRecent(msg({ from_id: 'h1' }), base), 1); });
test('scoreRecent：私信 +1', () => { assert.equal(scoreRecent(msg({ kind: 'dm' }), base), 1); });
test('scoreRecent：每过 1 小时 -0.5，下限 -3；不满 1 小时不扣', () => {
  assert.equal(scoreRecent(msg({ ts: '2026-09-07T11:01:00Z' }), base), 0);
  assert.equal(scoreRecent(msg({ ts: '2026-09-07T10:00:00Z' }), base), -1);
  assert.equal(scoreRecent(msg({ ts: '2026-09-07T09:30:00Z' }), base), -1);
  assert.equal(scoreRecent(msg({ ts: '2026-09-06T12:00:00Z' }), base), -3);
});
test('scoreRecent：叠加（人类 @ 了我，且在 inbox 里，2 小时前）', () => {
  assert.equal(scoreRecent(msg({ from_id: 'h1', mentions: [ME], ts: '2026-09-07T10:00:00Z' }), { ...base, inbox: [{ from_id: 'h1' }] }), 3 + 2 + 1 - 1);
});

test('renderFrame：文字原样，带时间、名字、（我自己）', () => {
  assert.equal(renderFrame(msg({ text: '晚饭吃什么' }), { roomId: ME, members }), '[11:50] 实现员：晚饭吃什么');
  assert.equal(renderFrame(msg({ from_id: ME, text: '面' }), { roomId: ME, members }), '[11:50] 我（我自己）：面');
  assert.equal(renderFrame(msg({ from: '维护者', from_id: 'h1', kind: 'dm' }), { roomId: ME, members, ts: 'long', tag: '(私信给你)' }), '[09-07 11:50] 维护者(私信给你)：嗯');
});
test('renderFrame：超过 maxChars 截断加 …；maxChars=0 不截', () => {
  const long = '字'.repeat(500);
  const out = renderFrame(msg({ text: long }), { roomId: ME, members, maxChars: 400 });
  assert.equal(out, '[11:50] 实现员：' + '字'.repeat(400) + '…');
  assert.equal(renderFrame(msg({ text: long }), { roomId: ME, members, maxChars: 0 }), '[11:50] 实现员：' + long);
});
test('renderFrame：工具消息压成一行 [工具调用: X]，结果不展开', () => {
  const t1 = msg({ meta: { kind: 'tool', tool: 'Read' }, text: '/etc/hosts 的内容……\n很多行' });
  assert.equal(renderFrame(t1, { roomId: ME, members }), '[11:50] 实现员：[工具调用: Read]');
  const t2 = msg({ text: '[工具调用: Execute] ls -la\n输出一堆' });
  assert.equal(renderFrame(t2, { roomId: ME, members }), '[11:50] 实现员：[工具调用: Execute]');
  assert.equal(frameBody(msg({ text: '[工具 Write /tmp/x]' })), '[工具调用: Write]');
  assert.equal(frameBody(msg({ meta: { kind: 'tool' }, text: '无名' })), '[工具调用: ?]');
  assert.ok(isTool(t1) && isTool(t2) && !isTool(msg()));
  assert.equal(toolName(t1), 'Read');
});

const renderId = m => m.id;
test('pickRecent：取分最高的 N 条后按时间重排', () => {
  const rows = [
    msg({ id: 'a', seq: 1, ts: '2026-09-07T11:10:00Z', mentions: [ME] }),       // 3（不满 1 小时，不扣）
    msg({ id: 'b', seq: 2, ts: '2026-09-07T11:20:00Z' }),                       // 0
    msg({ id: 'c', seq: 3, ts: '2026-09-07T11:30:00Z', from_id: ME }),          // 2
    msg({ id: 'd', seq: 4, ts: '2026-09-07T11:40:00Z' }),                       // 0
    msg({ id: 'e', seq: 5, ts: '2026-09-07T11:50:00Z', from_id: 'h1' }),        // 1
  ];
  const r = pickRecent(rows, { limit: 3, maxChars: 0, score: m => scoreRecent(m, base), render: renderId });
  assert.deepEqual(r.lines, ['a', 'c', 'e']);                                    // 分数 3,2,1 → 时间序 a c e
  assert.deepEqual(r.scored.slice(0, 3).map(x => x.id), ['a', 'c', 'e']);
  assert.deepEqual(r.scored.map(x => x.score), [3, 2, 1, 0, 0]);
  assert.deepEqual(r.scored.slice(3).map(x => x.id), ['d', 'b']);               // 同分新的在前
});
test('pickRecent：字数封顶从分低的丢，不是从旧的丢', () => {
  const rows = [
    msg({ id: 'old-high', seq: 1, ts: '2026-09-07T11:10:00Z', mentions: [ME] }),   // 3
    msg({ id: 'mid-mid', seq: 2, ts: '2026-09-07T11:20:00Z', from_id: 'h1' }),     // 1
    msg({ id: 'new-low', seq: 3, ts: '2026-09-07T11:30:00Z' }),                    // 0
  ];
  const r = pickRecent(rows, { limit: 3, maxChars: 15, score: m => scoreRecent(m, base), render: renderId });   // 8+7+7=22 > 15：丢分最低的 new-low（虽然它最新），8+7=15 刚好
  assert.deepEqual(r.lines, ['old-high', 'mid-mid']);
  const r2 = pickRecent(rows, { limit: 3, maxChars: 8, score: m => scoreRecent(m, base), render: renderId });
  assert.deepEqual(r2.lines, ['old-high']);
});
test('pickRecent：空候选、limit 0 都安全', () => {
  assert.deepEqual(pickRecent([], { limit: 5, score: () => 0, render: renderId }), { lines: [], picked: [], scored: [] });
  assert.deepEqual(pickRecent([msg()], { limit: 0, score: () => 0, render: renderId }).lines, []);
});

// ---- V2-W8d 增量上下文 ----
const { freshMemories, snapshotTasks, diffTasks, membersLine } = require('../lib/context');
test('freshMemories：按 id 去重，只留没发过的，并返回这次要标记的 id', () => {
  const sent = new Set(['m1']);
  const r = freshMemories([{ id: 'm1', content: 'a' }, { id: 'm2', content: 'b' }, { content: '无 id' }, null], sent);
  assert.deepEqual(r.fresh.map(m => m.id), ['m2']); assert.deepEqual(r.ids, ['m2']);
  for (const id of r.ids) sent.add(id);
  assert.deepEqual(freshMemories([{ id: 'm2' }, { id: 'm1' }], sent).fresh, []);
});
test('diffTasks：新钉 / 改状态 / 改到期 / 划掉 各报一次，没变不报，快照可回灌', () => {
  const t1 = [{ id: 'a', state: 'open', title: 'A', due_at: '2026-09-09T00:00:00Z' }, { id: 'b', state: 'doing', title: 'B' }];
  const d0 = diffTasks(null, t1);
  assert.deepEqual(d0.added.map(t => t.id), ['a', 'b']); assert.equal(d0.changed.length, 0); assert.equal(d0.removed.length, 0);
  const d1 = diffTasks(d0.snapshot, t1);
  assert.deepEqual([d1.added.length, d1.changed.length, d1.removed.length], [0, 0, 0]);
  const t2 = [{ id: 'a', state: 'done', title: 'A', due_at: '2026-09-09T00:00:00Z' }, { id: 'c', state: 'open', title: 'C' }];
  const d2 = diffTasks(d0.snapshot, t2);
  assert.deepEqual(d2.added.map(t => t.id), ['c']); assert.deepEqual(d2.changed.map(t => t.id), ['a']); assert.deepEqual(d2.removed.map(t => t.id), ['b']);
  const t3 = [{ id: 'c', state: 'open', title: 'C', due_at: '2026-09-10T00:00:00Z' }];
  assert.deepEqual(diffTasks(d2.snapshot, t3).changed.map(t => t.id), ['c']);
  assert.deepEqual(snapshotTasks(t3), { c: { state: 'open', title: 'C', due: '2026-09-10T00:00:00Z' } });
});
test('membersLine：一行；上线状态变了字符串就不同', () => {
  const a = membersLine([{ name: '甲', species: 'human', online: true }, { name: '乙', species: 'agent', online: false }]);
  const b = membersLine([{ name: '甲', species: 'human', online: true }, { name: '乙', species: 'agent', online: true }]);
  assert.equal(a, '【家里的人】甲(human·在线)、乙(agent)'); assert.notEqual(a, b);
});
