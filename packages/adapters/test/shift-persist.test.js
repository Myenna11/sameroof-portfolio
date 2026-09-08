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
