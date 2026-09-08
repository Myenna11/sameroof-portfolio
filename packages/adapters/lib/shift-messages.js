// 同屋 · 一班的对话累积（V2-W8）：一班一个会话，落盘，进程重启恢复，睡前归档。
// 三种 shift：纯内存（测试）、JSONL 持久化（broker-direct）、session 持久化（claude-code）。
// V2-W8b：加压缩触发——messages 估算超窗口 70% 时，先做摘要帧（不叫模型），再截断最早轮次。
'use strict';
const fs = require('fs');
const path = require('path');

// ---- 估算 token 数：字符数 / 2（中英混合的粗估，偏保守） ----
function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages) chars += (m.content || '').length;
  return Math.ceil(chars / 2);
}

// ---- 第一级压缩（不叫模型）：工具输出留壳、长 assistant 截断 ----
function compactMessage(m) {
  if (m.role === 'system') return m;  // system 不动
  const text = m.content || '';
  // 工具调用/结果：只留一行
  if (/^\s*\[工具/.test(text) || /tool_use|tool_result/i.test(text)) {
    const name = (text.match(/\[工具(?:调用|结果)?\s*[:：]?\s*(\S+)/) || [])[1] || '?';
    return { role: m.role, content: `[工具调用: ${name}]（内容已压缩）` };
  }
  // 超长消息截断到 800 字（保留开头和结尾各 350，中间用省略标记）
  if (text.length > 1600) {
    return { role: m.role, content: text.slice(0, 700) + '\n\n…（中间部分已压缩，共 ' + text.length + ' 字）…\n\n' + text.slice(-700) };
  }
  return m;
}

// ---- 压缩：保留 system + 最近 keepTurns 组 user/assistant，最早的部分做摘要帧后丢弃 ----
// 不丢 assistant（DECISIONS #21）：压缩只缩内容不删消息，但超限时截断最早的轮对。
// 返回是否做了压缩。
function compactMessages(messages, { maxTokens, keepTurns = 12 } = {}) {
  const est = estimateTokens(messages);
  const threshold = Math.floor(maxTokens * 0.7);
  if (est <= threshold) return false;

  // 先做第一级：所有非最近 keepTurns 组的消息做摘要帧
  // 找到保留区的起点：从后往前数 keepTurns 个 assistant
  let keepFrom = messages.length;
  let assistantCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      assistantCount++;
      if (assistantCount >= keepTurns) { keepFrom = i > 0 && messages[i - 1].role === 'user' ? i - 1 : i; break; }
    }
  }
  // system 永远保留（index 0）
  const systemEnd = messages[0] && messages[0].role === 'system' ? 1 : 0;
  if (keepFrom <= systemEnd) return false;  // 没什么可压的

  // 第一级：压缩 [systemEnd, keepFrom) 的消息
  for (let i = systemEnd; i < keepFrom; i++) {
    messages[i] = compactMessage(messages[i]);
  }

  // 检查压完还超不超
  if (estimateTokens(messages) <= threshold) return true;

  // 第二级：把 [systemEnd, keepFrom) 整段替换成一条 user 提示
  const removed = messages.splice(systemEnd, keepFrom - systemEnd);
  const turnPairs = [];
  for (let i = 0; i < removed.length; i += 2) {
    if (removed[i] && removed[i + 1]) turnPairs.push(`- ${(removed[i].content || '').slice(0, 80)}… → ${(removed[i + 1].content || '').slice(0, 80)}…`);
    else if (removed[i]) turnPairs.push(`- ${(removed[i].content || '').slice(0, 80)}…`);
  }
  const summary = `【上文压缩过，共 ${removed.length} 条消息被压缩。以下是概要：】\n${turnPairs.slice(0, 8).join('\n')}${turnPairs.length > 8 ? '\n…（还有 ' + (turnPairs.length - 8) + ' 条）' : ''}`;
  messages.splice(systemEnd, 0, { role: 'user', content: summary });

  return true;
}

// ---- 纯内存版（测试、一次性调用） ----
function createShift() {
  const messages = [];
  return {
    messages,
    open(system, user) {
      if (!messages.length) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: user });
      return messages;
    },
    commit(reply) { messages.push({ role: 'assistant', content: reply }); },
    retract() { if (messages.length && messages[messages.length - 1].role === 'user') messages.pop(); },
    turns() { return messages.filter(m => m.role === 'assistant').length; },
    archive() {},
  };
}

// ---- JSONL 持久化版（broker-direct 用） ----
function createPersistentShift(filePath, opts = {}) {
  const maxTokens = opts.maxTokens || 60000;  // 默认 60k（GLM-5.3-flash 是 128k 窗口，留余量）
  const keepTurns = opts.keepTurns || 12;
  const messages = [];
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(filePath)) {
    try {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.op === 'msg' && entry.role && entry.content != null) {
          messages.push({ role: entry.role, content: entry.content });
        } else if (entry.op === 'retract') {
          if (messages.length && messages[messages.length - 1].role === 'user') messages.pop();
        }
      }
      if (messages.length) fs.writeSync(2, `[shift] 从 ${filePath} 恢复了 ${messages.length} 条消息\n`);
    } catch (e) {
      fs.writeSync(2, `[shift] 恢复失败，当新班开：${e.message}\n`);
      messages.length = 0;
    }
  }

  function append(entry) {
    try { fs.appendFileSync(filePath, JSON.stringify(entry) + '\n'); }
    catch (e) { fs.writeSync(2, `[shift] 写盘失败：${e.message}\n`); }
  }

  // 压缩后重写整个 JSONL（因为内存里的 messages 已变）
  function rewriteFile() {
    try {
      const data = messages.map(m => JSON.stringify({ op: 'msg', role: m.role, content: m.content, ts: new Date().toISOString() })).join('\n') + '\n';
      fs.writeFileSync(filePath, data);
    } catch (e) { fs.writeSync(2, `[shift] 重写失败：${e.message}\n`); }
  }

  function compact() {
    const before = messages.length;
    const did = compactMessages(messages, { maxTokens, keepTurns });
    if (did) {
      rewriteFile();
      fs.writeSync(2, `[shift] 压缩：${before} → ${messages.length} 条，约 ${estimateTokens(messages)} tokens\n`);
    }
    return did;
  }

  return {
    messages,
    open(system, user) {
      if (!messages.length) {
        messages.push({ role: 'system', content: system });
        append({ op: 'msg', role: 'system', content: system, ts: new Date().toISOString() });
      }
      messages.push({ role: 'user', content: user });
      append({ op: 'msg', role: 'user', content: user, ts: new Date().toISOString() });
      return messages;
    },
    commit(reply) {
      messages.push({ role: 'assistant', content: reply });
      append({ op: 'msg', role: 'assistant', content: reply, ts: new Date().toISOString() });
    },
    retract() {
      if (messages.length && messages[messages.length - 1].role === 'user') {
        messages.pop();
        append({ op: 'retract', ts: new Date().toISOString() });
      }
    },
    turns() { return messages.filter(m => m.role === 'assistant').length; },
    compact,
    archive() {
      if (!fs.existsSync(filePath)) return null;
      const archiveDir = path.join(dir, 'shifts');
      fs.mkdirSync(archiveDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const base = path.basename(filePath, '.jsonl');
      const dest = path.join(archiveDir, `${ts}-${base}.jsonl`);
      try {
        fs.renameSync(filePath, dest);
        fs.writeSync(2, `[shift] 归档 → ${dest}（${messages.length} 条）\n`);
      } catch (e) {
        fs.writeSync(2, `[shift] 归档失败：${e.message}\n`);
        try { fs.unlinkSync(filePath); } catch {}
      }
      messages.length = 0;
      return dest;
    },
    filePath,
  };
}

// ---- Session 持久化版（claude-code 用）----
function createSessionShift(filePath) {
  const { randomUUID } = require('crypto');
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  let sessionId = null;
  let turnCount = 0;

  if (fs.existsSync(filePath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (saved.session_id) {
        sessionId = saved.session_id;
        turnCount = saved.turns || 0;
        fs.writeSync(2, `[cc-shift] 恢复 session ${sessionId}，已有 ${turnCount} 轮\n`);
      }
    } catch (e) { fs.writeSync(2, `[cc-shift] 恢复失败，当新班开：${e.message}\n`); }
  }

  function save() {
    try { fs.writeFileSync(filePath, JSON.stringify({ session_id: sessionId, turns: turnCount, updated: new Date().toISOString() })); }
    catch (e) { fs.writeSync(2, `[cc-shift] 保存失败：${e.message}\n`); }
  }

  return {
    messages: [],
    get sessionId() { return sessionId; },
    isFirst() { return !sessionId; },
    open() { if (!sessionId) sessionId = randomUUID(); return sessionId; },
    commit() { turnCount++; save(); },
    revert(wasFirst) { if (wasFirst) { sessionId = null; } },
    reset() { sessionId = null; turnCount = 0; try { fs.unlinkSync(filePath); } catch {} },
    turns() { return turnCount; },
    archive() {
      sessionId = null; turnCount = 0;
      try { fs.unlinkSync(filePath); } catch {}
      fs.writeSync(2, `[cc-shift] session 归档（清掉）\n`);
    },
    filePath,
  };
}

// ---- wrapThink ----
const textOf = r => (r && typeof r === 'object') ? (r.text == null ? '' : String(r.text)) : (r == null ? '' : String(r));

function wrapThink(call, shift = createShift()) {
  const think = async (system, user, signal) => {
    if (shift.messages.length && shift.messages[0].content !== system) return call([{ role: 'system', content: system }, { role: 'user', content: user }], signal);
    const messages = shift.open(system, user);
    let reply;
    try { reply = await call(messages, signal); } catch (e) { shift.retract(); throw e; }
    const text = textOf(reply);
    if (!text.trim()) { shift.retract(); return reply; }
    shift.commit(text);
    // 压缩检查：commit 后看看是否需要
    if (shift.compact) shift.compact();
    return reply;
  };
  think.shift = shift;
  return think;
}

module.exports = { createShift, createPersistentShift, createSessionShift, wrapThink, estimateTokens, compactMessages, compactMessage };
