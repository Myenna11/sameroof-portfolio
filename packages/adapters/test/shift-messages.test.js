// V2-T：broker-direct 的多轮消息累积——模拟两次 think，第二次发出去的 messages 要带着第一次的 assistant 回复。
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { wrapThink, createShift } = require('../lib/shift-messages');

const fake = replies => { const sent = []; const call = async messages => { sent.push(messages.map(m => ({ ...m }))); return replies.shift(); }; return { call, sent }; };

test('第一次发 system+user，第二次只追加 user，且带着上一轮的 assistant', async () => {
  const { call, sent } = fake(['我在', '睡了']);
  const think = wrapThink(call);
  assert.equal(await think('你是甲', '在吗', null), '我在');
  assert.deepEqual(sent[0], [{ role: 'system', content: '你是甲' }, { role: 'user', content: '在吗' }]);
  assert.equal(await think('你是甲', '晚安', null), '睡了');
  assert.equal(sent[1].length, 4);
  assert.deepEqual(sent[1], [{ role: 'system', content: '你是甲' }, { role: 'user', content: '在吗' }, { role: 'assistant', content: '我在' }, { role: 'user', content: '晚安' }]);
  assert.equal(sent[1].filter(m => m.role === 'system').length, 1);                     // system 不重发
  assert.equal(think.shift.messages.length, 5);                                          // 第二轮的回复也接上了
});
test('出错或回空：撤回那条 user，下一轮不会出现连着两条 user', async () => {
  const shift = createShift();
  let n = 0;
  const think = wrapThink(async () => { n++; if (n === 1) throw new Error('broker 502'); if (n === 2) return '   '; return '好'; }, shift);
  await assert.rejects(think('你是甲', '一', null), /502/);
  assert.equal(shift.messages.length, 1);                                                // 只剩 system
  assert.equal((await think('你是甲', '二', null)).trim(), '');
  assert.equal(shift.messages.length, 1);
  await think('你是甲', '三', null);
  assert.deepEqual(shift.messages.map(m => m.role), ['system', 'user', 'assistant']);
});
test('换了 system（睡前便条）是另一个话头：一次性发，不进这一班', async () => {
  const { call, sent } = fake(['在', '便条写好了', '嗯']);
  const think = wrapThink(call);
  await think('你是甲', '在吗', null);
  assert.equal(await think('你是甲。现在要睡了，写便条', '这一班的事实', null), '便条写好了');
  assert.deepEqual(sent[1], [{ role: 'system', content: '你是甲。现在要睡了，写便条' }, { role: 'user', content: '这一班的事实' }]);
  await think('你是甲', '还在吗', null);
  assert.deepEqual(think.shift.messages.map(m => m.role), ['system', 'user', 'assistant', 'user', 'assistant']);
  assert.equal(sent[2].length, 4);
});
test('call 回 { text, usage }：历史里只存 text，整个对象原样返回给 room.js', async () => {
  const { call, sent } = fake([{ text: '在', usage: { prompt_tokens: 10, completion_tokens: 2 } }, { text: '', usage: { prompt_tokens: 1 } }, '嗯']);
  const think = wrapThink(call);
  assert.deepEqual(await think('s', '一', null), { text: '在', usage: { prompt_tokens: 10, completion_tokens: 2 } });
  assert.deepEqual(think.shift.messages[2], { role: 'assistant', content: '在' });
  await think('s', '二', null);                                                          // text 空 → 撤回
  assert.equal(think.shift.messages.length, 3);
  await think('s', '三', null);
  assert.equal(sent[2].length, 4);
});
test('signal 原样传给 call', async () => {
  let seen; const think = wrapThink(async (_m, signal) => { seen = signal; return 'ok'; });
  const ac = new AbortController(); await think('s', 'u', ac.signal); assert.equal(seen, ac.signal);
});
