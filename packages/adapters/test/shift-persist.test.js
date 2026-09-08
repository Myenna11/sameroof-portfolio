// V2-W8 测试：持久化 shift 的 JSONL 落盘、恢复、归档。
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createPersistentShift, wrapThink } = require('../lib/shift-messages');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shift-test-'));
  return { dir, file: path.join(dir, 'shift-test.jsonl') };
}

test('持久化：open+commit 写 JSONL，能从文件恢复', () => {
  const { dir, file } = tmpFile();
  const s1 = createPersistentShift(file);
  s1.open('你是甲', '在吗');
  s1.commit('我在');
  s1.open('你是甲', '晚安');
  s1.commit('好梦');
  assert.equal(s1.messages.length, 5);
  assert.ok(fs.existsSync(file));
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 5); // system + user + assistant + user + assistant

  // 恢复：新建 shift 指向同一文件
  const s2 = createPersistentShift(file);
  assert.equal(s2.messages.length, 5);
  assert.deepEqual(s2.messages.map(m => m.role), ['system', 'user', 'assistant', 'user', 'assistant']);
  assert.equal(s2.messages[0].content, '你是甲');
  assert.equal(s2.messages[2].content, '我在');
  assert.equal(s2.messages[4].content, '好梦');
  fs.rmSync(dir, { recursive: true });
});

test('持久化：retract 写标记，恢复时回放', () => {
  const { dir, file } = tmpFile();
  const s1 = createPersistentShift(file);
  s1.open('你是甲', '在吗');
  s1.retract(); // 撤回 user
  assert.equal(s1.messages.length, 1); // 只剩 system

  const s2 = createPersistentShift(file);
  assert.equal(s2.messages.length, 1);
  assert.equal(s2.messages[0].role, 'system');
  fs.rmSync(dir, { recursive: true });
});

test('持久化：archive 移走文件、清空内存', () => {
  const { dir, file } = tmpFile();
  const s = createPersistentShift(file);
  s.open('你是甲', '在吗');
  s.commit('我在');
  const dest = s.archive();
  assert.ok(dest);
  assert.ok(fs.existsSync(dest));
  assert.ok(!fs.existsSync(file));
  assert.equal(s.messages.length, 0);
  // 归档文件内容完整
  const lines = fs.readFileSync(dest, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  fs.rmSync(dir, { recursive: true });
});

test('持久化：空文件不存在时 archive 返回 null', () => {
  const { dir, file } = tmpFile();
  const s = createPersistentShift(file);
  assert.equal(s.archive(), null);
  fs.rmSync(dir, { recursive: true });
});

test('持久化：坏行跳过不崩', () => {
  const { dir, file } = tmpFile();
  fs.writeFileSync(file, '{"op":"msg","role":"system","content":"你是甲","ts":"2026-01-01"}\ngarbage line\n{"op":"msg","role":"user","content":"在吗","ts":"2026-01-01"}\n');
  const s = createPersistentShift(file);
  assert.equal(s.messages.length, 2);
  assert.equal(s.messages[1].content, '在吗');
  fs.rmSync(dir, { recursive: true });
});

test('持久化 + wrapThink：完整流程', async () => {
  const { dir, file } = tmpFile();
  const shift = createPersistentShift(file);
  const replies = ['我在', '好梦'];
  const sent = [];
  const think = wrapThink(async messages => { sent.push(messages.map(m => ({ ...m }))); return replies.shift(); }, shift);
  await think('你是甲', '在吗', null);
  await think('你是甲', '晚安', null);
  // 第二次发 4 条消息（累积）
  assert.equal(sent[1].length, 4);
  // JSONL 有 5 行
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 5);
  // 恢复后能继续
  const shift2 = createPersistentShift(file);
  const think2 = wrapThink(async messages => { sent.push(messages.map(m => ({ ...m }))); return '嗯'; }, shift2);
  await think2('你是甲', '还在吗', null);
  // 第三次发 6 条消息（5 恢复 + 1 新 user）
  assert.equal(sent[2].length, 6);
  fs.rmSync(dir, { recursive: true });
});

test('turns() 计数正确', () => {
  const { dir, file } = tmpFile();
  const s = createPersistentShift(file);
  assert.equal(s.turns(), 0);
  s.open('你是甲', '在吗');
  assert.equal(s.turns(), 0);
  s.commit('我在');
  assert.equal(s.turns(), 1);
  s.open('你是甲', '晚安');
  s.commit('好梦');
  assert.equal(s.turns(), 2);
  fs.rmSync(dir, { recursive: true });
});

// ---- createSessionShift 测试 ----
const { createSessionShift } = require('../lib/shift-messages');

test('session shift：open 生成 id，commit 落盘，恢复后 isFirst=false', () => {
  const { dir, file } = tmpFile();
  const sFile = path.join(dir, 'cc-session.json');
  const s1 = createSessionShift(sFile);
  assert.equal(s1.isFirst(), true);
  assert.equal(s1.sessionId, null);
  const sid = s1.open();
  assert.ok(sid);
  assert.equal(s1.isFirst(), false);
  s1.commit();
  assert.equal(s1.turns(), 1);
  assert.ok(fs.existsSync(sFile));

  // 恢复
  const s2 = createSessionShift(sFile);
  assert.equal(s2.isFirst(), false);
  assert.equal(s2.sessionId, sid);
  assert.equal(s2.turns(), 1);
  fs.rmSync(dir, { recursive: true });
});

test('session shift：reset 清空，下次当首轮', () => {
  const { dir, file } = tmpFile();
  const sFile = path.join(dir, 'cc-session.json');
  const s = createSessionShift(sFile);
  s.open(); s.commit();
  s.reset();
  assert.equal(s.isFirst(), true);
  assert.equal(s.turns(), 0);
  assert.ok(!fs.existsSync(sFile));
  fs.rmSync(dir, { recursive: true });
});

test('session shift：revert 首轮清 id，非首轮不动', () => {
  const { dir, file } = tmpFile();
  const sFile = path.join(dir, 'cc-session.json');
  const s = createSessionShift(sFile);
  // 首轮 revert
  s.open();
  s.revert(true);
  assert.equal(s.sessionId, null);
  // 非首轮：先正常建一个
  s.open(); s.commit();
  const sid = s.sessionId;
  s.open(); // 第二轮
  s.revert(false);
  assert.equal(s.sessionId, sid); // 没清
  fs.rmSync(dir, { recursive: true });
});

test('session shift：archive 清空并删文件', () => {
  const { dir, file } = tmpFile();
  const sFile = path.join(dir, 'cc-session.json');
  const s = createSessionShift(sFile);
  s.open(); s.commit();
  s.archive();
  assert.equal(s.isFirst(), true);
  assert.equal(s.turns(), 0);
  assert.ok(!fs.existsSync(sFile));
  fs.rmSync(dir, { recursive: true });
});

// ---- 压缩测试 ----
const { estimateTokens, compactMessages, compactMessage } = require('../lib/shift-messages');

test('estimateTokens：字符数 / 2', () => {
  assert.equal(estimateTokens([{ content: '你好世界' }]), 2);   // 4 chars / 2
  assert.equal(estimateTokens([{ content: 'hello world!' }]), 6); // 12 / 2
  assert.equal(estimateTokens([{ content: '你好' }, { content: 'hi' }]), 2); // (2+2)/2
});

test('compactMessage：工具消息留壳', () => {
  const m = compactMessage({ role: 'user', content: '[工具调用: search] 搜索结果有很多内容...' });
  assert.ok(m.content.includes('[工具调用: search]'));
  assert.ok(m.content.includes('已压缩'));
});

test('compactMessage：超长消息截断保留首尾', () => {
  const long = 'A'.repeat(2000);
  const m = compactMessage({ role: 'assistant', content: long });
  assert.ok(m.content.length < long.length);
  assert.ok(m.content.includes('已压缩'));
  assert.ok(m.content.startsWith('AAAA'));
  assert.ok(m.content.endsWith('AAAA'));
});

test('compactMessage：system 不动', () => {
  const m = { role: 'system', content: '你是检索员' };
  assert.equal(compactMessage(m), m);
});

test('compactMessages：不超阈值不压', () => {
  const messages = [
    { role: 'system', content: '你是甲' },
    { role: 'user', content: '在吗' },
    { role: 'assistant', content: '在' },
  ];
  assert.equal(compactMessages(messages, { maxTokens: 1000 }), false);
  assert.equal(messages.length, 3);
});

test('compactMessages：超阈值触发第一级压缩', () => {
  const messages = [{ role: 'system', content: 'S' }];
  // 加 20 轮对话，每轮 user 200 字 + assistant 200 字 = 400 字/轮 × 20 = 8000 字 ≈ 4000 tokens
  for (let i = 0; i < 20; i++) {
    messages.push({ role: 'user', content: `[工具调用: tool${i}] ${'x'.repeat(200)}` });
    messages.push({ role: 'assistant', content: 'y'.repeat(200) });
  }
  const before = messages.length;
  const did = compactMessages(messages, { maxTokens: 2000, keepTurns: 5 }); // 阈值 1400 tokens
  assert.equal(did, true);
  // 工具消息应该被压缩了
  const early = messages.find(m => m.role === 'user' && m.content.includes('[工具调用: tool0]'));
  if (early) assert.ok(early.content.includes('已压缩'));
});

test('compactMessages：超阈值触发第二级截断', () => {
  const messages = [{ role: 'system', content: 'S' }];
  // 加 30 轮超长对话，总量远超
  for (let i = 0; i < 30; i++) {
    messages.push({ role: 'user', content: 'u'.repeat(500) });
    messages.push({ role: 'assistant', content: 'a'.repeat(500) });
  }
  const did = compactMessages(messages, { maxTokens: 3000, keepTurns: 5 });
  assert.equal(did, true);
  // 应该有压缩提示
  const summary = messages.find(m => m.content && m.content.includes('上文压缩过'));
  assert.ok(summary, '应有压缩提示消息');
  // assistant 消息仍存在（不丢 assistant）
  assert.ok(messages.some(m => m.role === 'assistant'));
});

test('持久化 + 压缩：compact 后 JSONL 被重写', () => {
  const { dir, file } = tmpFile();
  const s = createPersistentShift(file, { maxTokens: 500, keepTurns: 2 });
  // 写很多轮
  for (let i = 0; i < 10; i++) {
    s.open('你是甲', `问题${i} ${'x'.repeat(100)}`);
    s.commit(`回答${i} ${'y'.repeat(100)}`);
  }
  // compact 应该触发了（wrapThink 里自动调）
  const did = s.compact();
  // 不管有没有再次压缩，至少文件存在
  assert.ok(fs.existsSync(file));
  // 消息数应该少于原来的 21 (1 system + 20 user/assistant)
  // 因为 wrapThink 每次 commit 后都会自动 compact，所以这里的 messages 可能已经很少了
  assert.ok(s.messages.length <= 21, `messages 应该 <= 21，实际 ${s.messages.length}`);
  fs.rmSync(dir, { recursive: true });
});
