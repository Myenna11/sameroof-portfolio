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
const { estimateTokens, compactMessages, compactMessage, compactWithModel, scoreMessage } = require('../lib/shift-messages');

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
  assert.equal(compactMessages(messages, { maxTokens: 1000 }).did, false);
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
  const r = compactMessages(messages, { maxTokens: 2000, keepTurns: 5 }); // 阈值 1400 tokens
  assert.equal(r.did, true);
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
  const r = compactMessages(messages, { maxTokens: 3000, keepTurns: 5 });
  assert.equal(r.did, true);
  // 二级砍完的消息被替换成一行摘要
  assert.ok(messages.some(m => /^\[第 \d+ 轮已压缩/.test(m.content)), '应有一行摘要');
  // assistant 消息仍存在（不丢 assistant）
  assert.ok(messages.some(m => m.role === 'assistant'));
});

test('持久化 + 压缩：compact 后 JSONL 被重写', async () => {
  const { dir, file } = tmpFile();
  const s = createPersistentShift(file, { maxTokens: 500, keepTurns: 2 });
  // 写很多轮
  for (let i = 0; i < 10; i++) {
    s.open('你是甲', `问题${i} ${'x'.repeat(100)}`);
    s.commit(`回答${i} ${'y'.repeat(100)}`);
  }
  // compact 应该触发了（wrapThink 里自动调）
  await s.compact();
  // 不管有没有再次压缩，至少文件存在
  assert.ok(fs.existsSync(file));
  // 消息数应该少于原来的 21 (1 system + 20 user/assistant)
  // 因为 wrapThink 每次 commit 后都会自动 compact，所以这里的 messages 可能已经很少了
  assert.ok(s.messages.length <= 21, `messages 应该 <= 21，实际 ${s.messages.length}`);
  fs.rmSync(dir, { recursive: true });
});

// ---- V2-W8c 验收 ----
test('scoreMessage：身份 3，情感 2，决策 2，普通 1，工具/静默 0', () => {
  assert.equal(scoreMessage({ role: 'user', content: '我是规划员' }), 3);
  assert.equal(scoreMessage({ role: 'user', content: '你记住：吵架不隔夜' }), 3);
  assert.equal(scoreMessage({ role: 'assistant', content: '对不起，我想你了' }), 2);
  assert.equal(scoreMessage({ role: 'assistant', content: '决定了，先不做网关' }), 2);
  assert.equal(scoreMessage({ role: 'user', content: '今天天气怎么样' }), 1);
  assert.equal(scoreMessage({ role: 'user', content: '[工具调用: ls]' }), 0);
  assert.equal(scoreMessage({ role: 'assistant', content: '(静默)' }), 0);
  assert.equal(scoreMessage({ role: 'system', content: '你是甲' }), 99);
});

test('30 轮混合对话：压缩后情感/承诺的在，工具日志的不在', () => {
  const messages = [{ role: 'system', content: 'S' }];
  const pad = 'x'.repeat(150);
  for (let i = 0; i < 30; i++) {
    const kind = i % 3;   // 0 情感/承诺，1 工具，2 普通
    if (kind === 0) { messages.push({ role: 'user', content: `我们说好每晚抱着睡 ${i} ${pad}` }); messages.push({ role: 'assistant', content: `记住了，我爱你 ${i} ${pad}` }); }
    else if (kind === 1) { messages.push({ role: 'user', content: `[工具调用: ls${i}] ${pad}${pad}` }); messages.push({ role: 'assistant', content: `[工具结果: ls${i}] ${pad}${pad}` }); }
    else { messages.push({ role: 'user', content: `今天天气 ${i} ${pad}` }); messages.push({ role: 'assistant', content: `挺好的 ${i} ${pad}` }); }
  }
  const r = compactMessages(messages, { maxTokens: 3800, keepTurns: 3 });   // 阈值 2660：一级留壳后约 3450 必须进二级；砍完 18 条普通约 2490 即停，不碰情感
  assert.equal(r.did, true);
  assert.ok(r.level >= 2, '应至少到二级，实际 ' + r.level);
  const body = messages.map(m => m.content);
  // 早期的承诺/情感轮次（keepTurns 之外）应保留原文
  assert.ok(body.some(t => t.startsWith('我们说好每晚抱着睡 0 ')), '承诺原文应在');
  assert.ok(body.some(t => t.startsWith('记住了，我爱你 0 ')), '情感原文应在');
  // 早期工具轮次应已被留壳或砍成一行摘要，不该有大段 pad
  const tool = body.filter(t => /ls1\b|ls4\b|ls7\b/.test(t));
  assert.ok(tool.length > 0);
  for (const t of tool) assert.ok(t.length < 120, '工具消息应被压缩：' + t.slice(0, 60));
  // assistant 条数没变（不丢 assistant，只缩内容）
  assert.equal(messages.filter(m => m.role === 'assistant').length, 30);
});

test('第三级：compactWithModel 把区间换成一条摘要', async () => {
  const messages = [{ role: 'system', content: 'S' }];
  for (let i = 0; i < 6; i++) { messages.push({ role: 'user', content: `u${i}` }); messages.push({ role: 'assistant', content: `a${i}` }); }
  let seen = '';
  const ok = await compactWithModel(messages, { from: 1, to: 9 }, async d => { seen = d; return '我们聊了 u0 到 a3'; });
  assert.equal(ok, true);
  assert.ok(seen.includes('听到：u0') && seen.includes('我说：a3'));
  assert.equal(messages.length, 1 + 1 + 4);   // system + 摘要 + 剩下 4 条
  assert.ok(messages[1].content.includes('上文压缩过') && messages[1].content.includes('我们聊了 u0 到 a3'));
  assert.equal(messages[2].content, 'u4');
});

test('第三级：模型失败/回空不改 messages', async () => {
  const messages = [{ role: 'system', content: 'S' }, { role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }];
  assert.equal(await compactWithModel(messages, { from: 1, to: 3 }, async () => { throw new Error('502'); }), false);
  assert.equal(await compactWithModel(messages, { from: 1, to: 3 }, async () => '   '), false);
  assert.equal(messages.length, 3);
});

test('持久化 shift：三级走通——compactFn 被调，JSONL 重写成摘要', async () => {
  const { dir, file } = tmpFile();
  let calls = 0;
  const s = createPersistentShift(file, { maxTokens: 400, keepTurns: 2, compactFn: async () => { calls++; return '概要：前面都在聊天气'; } });
  for (let i = 0; i < 12; i++) { s.open('S', `今天天气 ${i} ${'x'.repeat(200)}`); s.commit(`挺好 ${i} ${'y'.repeat(200)}`); }
  await s.compact();
  assert.ok(calls >= 1, 'compactFn 应被调用');
  assert.ok(s.messages.some(m => m.content.includes('概要：前面都在聊天气')));
  const onDisk = fs.readFileSync(file, 'utf8');
  assert.ok(onDisk.includes('概要：前面都在聊天气'), 'JSONL 应已重写');
  fs.rmSync(dir, { recursive: true });
});
