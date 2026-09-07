// 黑板（W7）：PIN 指令解析（钉 / 改状态 / 到期三种写法 / 非法回 null）+ due 落 routine 的纯函数 + 渲染。
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { parsePin, syncTaskRoutines, renderTaskLines, buildRoutine, parseAt } = require('../lib/blackboard');
const room = require('../lib/room');

const TZ = 'Asia/Shanghai';

test('parsePin 钉：只有标题必填，| 段可选、顺序无关，中英冒号都认', () => {
  assert.deepEqual(parsePin('PIN: 把 demo 家的 README 写了'), { op: 'pin', title: '把 demo 家的 README 写了' });
  assert.deepEqual(parsePin('PIN： 写 README | 验收: 前十分钟两条路 | 给: 度量员'), { op: 'pin', title: '写 README', accept: '前十分钟两条路', owner: '度量员' });
  assert.deepEqual(parsePin('  pin: 写 README | 给: 度量员 | 验收：两条路 '), { op: 'pin', title: '写 README', owner: '度量员', accept: '两条路' });
  assert.deepEqual(parsePin('PIN: 标题 | 验收: | 给: '), { op: 'pin', title: '标题' });         // 空段跳过
  assert.equal(parsePin('PIN: 标题 | 随手一句'), null);                                          // 认不得的段 → null，整行不算
  assert.equal(parsePin('PIN:'), null);
  assert.equal(parsePin('PIN:   | 给: 度量员'), null);
  assert.equal(parsePin('REMEMBER: 今天没事'), null);
  assert.equal(parsePin('PINNED: x'), null);
  assert.equal(parsePin(null), null);
});
test('parsePin 到期：五段 cron → due_cron；带时区 ISO 按写的算；不带时区按房子 tz；看不懂 → null', () => {
  assert.equal(parsePin('PIN: 每天看一眼 | 到期: 0 9 * * 1-5').due_cron, '0 9 * * 1-5');
  assert.equal(parsePin('PIN: x | 到期:  0   9 * * *').due_cron, '0 9 * * *');                   // 多余空白收成一个
  assert.equal(parsePin('PIN: x | 到期: 2026-09-08T21:00+08:00').due_at, '2026-09-08T13:00:00.000Z');
  assert.equal(parsePin('PIN: x | 到期: 2026-09-08T13:00Z').due_at, '2026-09-08T13:00:00.000Z');
  assert.equal(parsePin('PIN: x | 到期: 2026-09-08 21:00', { tz: TZ }).due_at, '2026-09-08T13:00:00.000Z');   // 不带时区：房子时区
  assert.equal(parsePin('PIN: x | 到期: 2026-09-08T21:00', { tz: 'UTC' }).due_at, '2026-09-08T21:00:00.000Z');
  assert.equal(parsePin('PIN: x | 到期: 2026-09-08', { tz: TZ }).due_at, '2026-09-07T16:00:00.000Z');          // 只给日期 = 当天 00:00
  assert.equal(parsePin('PIN: x | 到期: 明天上午'), null);
  assert.equal(parsePin('PIN: x | 到期: 99 9 * * *'), null);
  assert.equal(parsePin('PIN: x | 到期: 2026-02-30T10:00Z'), null);
  const both = parsePin('PIN: x | 到期: 0 9 * * *'); assert.equal(both.due_at, undefined);
});
test('parsePin 改状态：PIN <task_id>: doing / done 结果 / blocked 原因 / drop 理由（drop → dropped）', () => {
  assert.deepEqual(parsePin('PIN task_mf1abc123: doing'), { op: 'update', id: 'task_mf1abc123', state: 'doing' });
  assert.deepEqual(parsePin('PIN task_mf1abc123: done 写好了在 README.en.md'), { op: 'update', id: 'task_mf1abc123', state: 'done', text: '写好了在 README.en.md' });
  assert.deepEqual(parsePin('PIN task_mf1abc123：blocked 等 W5'), { op: 'update', id: 'task_mf1abc123', state: 'blocked', text: '等 W5' });
  assert.deepEqual(parsePin('PIN task_mf1abc123: drop 不该我做'), { op: 'update', id: 'task_mf1abc123', state: 'dropped', text: '不该我做' });
  assert.deepEqual(parsePin('PIN task_mf1abc123: DONE'), { op: 'update', id: 'task_mf1abc123', state: 'done' });
  assert.equal(parsePin('PIN task_mf1abc123: flying'), null);
  assert.equal(parsePin('PIN task_x: done'), null);                                                 // id 太短不像客厅发的
  assert.equal(parsePin('PIN task_mf1abc123 done'), null);                                          // 少冒号
  assert.equal(room.parsePin('PIN task_mf1abc123: doing').state, 'doing');                          // room.js 也导出
});
test('DONE: 仍只划惦记本，不是黑板', () => {
  assert.equal(parsePin('DONE: task_mf1abc123'), null);
});

const T = (id, over = {}) => ({ id, title: '事 ' + id, state: 'open', ...over });
test('syncTaskRoutines：有 due 且 open/doing 的加 routine；done/dropped/blocked/archived/没 due 的移除；改到期算 changed；不碰非 task: 的', () => {
  const routines = [buildRoutine({ id: 'morning', cron: '0 9 * * *', prompt: '早' }, 'house.yaml', TZ)];
  let d = syncTaskRoutines(routines, [T('task_aaaaaa', { due_at: '2026-09-08T13:00:00.000Z' }), T('task_bbbbbb', { due_cron: '0 9 * * 1-5', state: 'doing' }), T('task_cccccc'), T('task_dddddd', { due_at: '2026-09-08T13:00:00.000Z', state: 'blocked' })], TZ);
  assert.deepEqual(d, { added: ['task:task_aaaaaa', 'task:task_bbbbbb'], removed: [], changed: [] });
  assert.deepEqual(routines.map(r => r.id), ['morning', 'task:task_aaaaaa', 'task:task_bbbbbb']);
  const a = routines[1];
  assert.deepEqual({ at: a.at, at_ms: a.at_ms, late_grace_ms: a.late_grace_ms, enabled: a.enabled, quiet_hours: a.quiet_hours, prompt: a.prompt },
    { at: '2026-09-08T13:00:00.000Z', at_ms: Date.parse('2026-09-08T13:00:00Z'), late_grace_ms: 24 * 3600000, enabled: true, quiet_hours: 'ignore', prompt: '黑板任务到期：「事 task_aaaaaa」，看一眼该做什么、说一句。' });
  assert.equal(routines[2].cron, '0 9 * * 1-5'); assert.equal(routines[2].at, undefined);
  // 再同步一遍同样的：什么都不动
  d = syncTaskRoutines(routines, [T('task_aaaaaa', { due_at: '2026-09-08T13:00:00.000Z' }), T('task_bbbbbb', { due_cron: '0 9 * * 1-5', state: 'doing' })], TZ);
  assert.deepEqual(d, { added: [], removed: [], changed: [] });
  // a 改了到期 → changed；b 做完了 → removed；新来 e（archived）不加
  d = syncTaskRoutines(routines, [T('task_aaaaaa', { due_at: '2026-09-09T13:00:00.000Z' }), T('task_bbbbbb', { due_cron: '0 9 * * 1-5', state: 'done' }), T('task_eeeeee', { due_at: '2026-09-09T13:00:00.000Z', archived: true })], TZ);
  assert.deepEqual(d, { added: [], removed: ['task:task_bbbbbb'], changed: ['task:task_aaaaaa'] });
  assert.deepEqual(routines.map(r => r.id), ['morning', 'task:task_aaaaaa']);
  assert.equal(routines[1].at, '2026-09-09T13:00:00.000Z');
  // 列表空（拉不到当没有）→ task: 的全拆，morning 不动
  d = syncTaskRoutines(routines, [], TZ);
  assert.deepEqual(d, { added: [], removed: ['task:task_aaaaaa'], changed: [] });
  assert.deepEqual(routines.map(r => r.id), ['morning']);
  assert.deepEqual(syncTaskRoutines(routines, null, TZ), { added: [], removed: [], changed: [] });
  assert.equal(room.syncTaskRoutines, syncTaskRoutines);
});
test('syncTaskRoutines 加出来的 routine 能过 dueNow', () => {
  const routines = []; syncTaskRoutines(routines, [T('task_aaaaaa', { due_at: '2026-09-08T13:00:00.000Z' })], TZ);
  assert.equal(room.dueNow(routines[0], {}, new Date('2026-09-08T13:00:10Z'), TZ), '2026-09-08T13:00:00.000Z');
  assert.equal(room.dueNow(routines[0], {}, new Date('2026-09-08T12:59:00Z'), TZ), null);
  assert.equal(room.dueNow(routines[0], { routines: { 'task:task_aaaaaa': { done: true } } }, new Date('2026-09-08T13:00:10Z'), TZ), null);
});
test('renderTaskLines：≤10 条，带状态、id、验收、到期（房子时区）', () => {
  const lines = renderTaskLines([T('task_aaaaaa', { state: 'doing', accept: '两条路', due_at: '2026-09-08T13:00:00.000Z' }), T('task_bbbbbb', { due_cron: '0 9 * * *' }), T('task_cccccc', { state: 'blocked', notes: '等 W5' })], TZ);
  assert.deepEqual(lines, ['- [doing] task_aaaaaa 事 task_aaaaaa（验收: 两条路；到期: 2026-09-08 21:00 Asia/Shanghai）', '- [open] task_bbbbbb 事 task_bbbbbb（到期: 每 0 9 * * *）', '- [blocked] task_cccccc 事 task_cccccc（卡在: 等 W5）']);
  assert.equal(renderTaskLines(Array.from({ length: 14 }, (_, i) => T('task_' + String(i).padStart(6, '0'))), TZ).length, 10);
  assert.deepEqual(renderTaskLines(null), []);
});
test('parseAt / buildRoutine 从 room.js 抽出来后行为不变', () => {
  assert.equal(parseAt('2026-09-08T21:00', TZ, 'x'), Date.parse('2026-09-08T13:00:00Z'));
  assert.throws(() => buildRoutine({ id: 'a', cron: '* * * * *', at: '2026-09-08', prompt: 'p' }, 'x', TZ), /二选一/);
  assert.throws(() => buildRoutine({ id: 'a', cron: '* * * * *', prompt: 'p', late_grace: '1h' }, 'x', TZ), /late_grace 只对 at 型/);
});
