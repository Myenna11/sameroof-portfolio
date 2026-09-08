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

// ---- 第一级压缩（不叫模型）：工具输出留壳、长消息截断 ----
function compactMessage(m) {
  if (m.role === 'system') return m;  // system 不动
  const text = m.content || '';
  // 工具调用/结果：只留一行
  if (/^\s*\[工具/.test(text) || /tool_use|tool_result/i.test(text)) {
    const name = (text.match(/\[工具(?:调用|结果)?\s*[:：]?\s*(\S+)/) || [])[1] || '?';
    return { role: m.role, content: `[工具调用: ${name}]（内容已压缩）` };
  }
  // 超长消息截断（保留首尾各 700 字）
  if (text.length > 1600) {
    return { role: m.role, content: text.slice(0, 700) + '\n\n…（中间部分已压缩，共 ' + text.length + ' 字）…\n\n' + text.slice(-700) };
  }
  return m;
}

// ---- 第二级打分（不叫模型）：给每条消息打分，低分先砍 ----
// 身份/偏好/边界/承诺 +3；情感/关系 +2；决策/结论 +2；普通对话 +1；工具/日志/状态 0。
// 权重偏向情感和关系而非代码——这是"人机共居"场景的压缩算法（V2_PLAN §六）。
const SCORE_RULES = [
  { score: 3, re: /我是|我叫|我的名字|我们说好|说好了|你记住|记住[：:]|答应|承诺|约定|不许|不准|底线|原则|永远(不|都)|我喜欢|我不喜欢|我讨厌|我要的是/ },
  { score: 2, re: /我想你|想你|对不起|抱歉|谢谢|感谢|生气|开心|难过|委屈|喜欢你|爱你|我爱|心疼|担心|害怕|紧张|放心|安心|抱抱|亲亲|晚安|早安|哭|笑/ },
  { score: 2, re: /决定|定了|就这样|不做|先不|改成|换成|取消|以后|下次|计划|安排|待办|要做|该做/ },
];
function scoreMessage(m) {
  const text = String(m.content || '');
  if (m.role === 'system') return 99;  // system 永不砍
  if (/^\s*\[工具/.test(text) || /tool_use|tool_result/i.test(text)) return 0;
  if (/^\s*[(（]静默[)）]/.test(text)) return 0;
  if (/^\s*\[(状态|日志|log|status|心跳|heartbeat)/i.test(text)) return 0;
  if (/^【上文压缩过|^\[第 \d+ 轮已压缩/.test(text)) return 0;   // 已压缩的不再计分，避免重复
  let best = 1;
  for (const r of SCORE_RULES) if (r.re.test(text) && r.score > best) best = r.score;
  return best;
}
// 被砍的消息替换成一行摘要
function summarizeLine(m, turnIdx) {
  const text = String(m.content || '').replace(/\s+/g, ' ').trim();
  const head = text.slice(0, 40);
  return `[第 ${turnIdx} 轮已压缩：${m.role === 'user' ? '听到' : '我说'}「${head}${text.length > 40 ? '…' : ''}」]`;
}

// ---- 压缩主函数：三级 ----
// 返回 { did, level }：did 是否压了，level 压到第几级（0 没压，1/2 不叫模型，3 需要叫模型——返回 needModel 区间，由调用方处理）
// 不丢 assistant（DECISIONS #21）：砍掉的消息替换成一行摘要，不整条删。
function compactMessages(messages, { maxTokens, keepTurns = 12 } = {}) {
  const threshold = Math.floor(maxTokens * 0.7);
  if (estimateTokens(messages) <= threshold) return { did: false, level: 0 };

  // 保留区：最近 keepTurns 个 assistant 及其前面的 user
  let keepFrom = messages.length;
  let assistantCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      assistantCount++;
      if (assistantCount >= keepTurns) { keepFrom = i > 0 && messages[i - 1].role === 'user' ? i - 1 : i; break; }
    }
  }
  const systemEnd = messages[0] && messages[0].role === 'system' ? 1 : 0;
  if (keepFrom <= systemEnd) return { did: false, level: 0 };

  // 第一级：[systemEnd, keepFrom) 工具留壳、长消息截断
  for (let i = systemEnd; i < keepFrom; i++) messages[i] = compactMessage(messages[i]);
  if (estimateTokens(messages) <= threshold) return { did: true, level: 1 };

  // 第二级：打分，低分先砍，砍到阈值以下为止
  const candidates = [];
  for (let i = systemEnd; i < keepFrom; i++) {
    if (/^\[第 \d+ 轮已压缩/.test(String(messages[i].content || ''))) continue;   // 已砍过的跳过
    candidates.push({ i, score: scoreMessage(messages[i]), len: (messages[i].content || '').length });
  }
  candidates.sort((a, b) => a.score - b.score || b.len - a.len);   // 分低先砍，同分长的先砍
  for (const c of candidates) {
    if (estimateTokens(messages) <= threshold) break;
    const turnIdx = Math.floor((c.i - systemEnd) / 2) + 1;
    messages[c.i] = { role: messages[c.i].role, content: summarizeLine(messages[c.i], turnIdx) };
  }
  if (estimateTokens(messages) <= threshold) return { did: true, level: 2 };

  // 第三级：打分砍完还超——返回需要叫模型压的区间，由调用方（有 call 能力的）处理
  return { did: true, level: 3, needModel: { from: systemEnd, to: keepFrom } };
}

// 第三级的 compact prompt
const COMPACT_PROMPT = `请将以下对话压缩为一段概要（不超过 500 字）。要求：
1. 保留所有承诺、决策、身份相关内容的原话
2. 保留情感状态和关系变化
3. 记录未完成的事和接下来的计划
4. 工具调用只保留"做了什么、结果如何"一句话
5. 用第一人称写（"我们讨论了…"、"你说了…"）`;

// 第三级：叫模型。compactFn(messagesSlice) → Promise<string>；成功后把区间替换成一条 user 摘要
async function compactWithModel(messages, { from, to }, compactFn) {
  const slice = messages.slice(from, to);
  const dialogue = slice.map(m => `${m.role === 'user' ? '听到' : '我说'}：${m.content}`).join('\n\n');
  let summary;
  try { summary = await compactFn(dialogue); }
  catch (e) { fs.writeSync(2, `[shift] 第三级压缩叫模型失败：${e.message}\n`); return false; }
  if (!summary || !String(summary).trim()) return false;
  messages.splice(from, to - from, { role: 'user', content: `【上文压缩过（${slice.length} 条），以下是概要，细节以交接信和记忆为准：】\n${String(summary).trim()}` });
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
  const compactFn = opts.compactFn || null;   // 第三级叫模型：(dialogueText) => Promise<summary>；不给就停在二级
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

  // 压缩：一二级同步（不叫模型）；到第三级时，如果有 compactFn 就叫模型，否则停在二级
  async function compact() {
    const before = messages.length;
    const r = compactMessages(messages, { maxTokens, keepTurns });
    if (!r.did) return false;
    let level = String(r.level);
    if (r.level === 3) {
      if (!compactFn) level = '3(无 compactFn，停在二级)';
      else level = (await compactWithModel(messages, r.needModel, compactFn)) ? '3(模型)' : '3(模型失败，停在二级)';
    }
    rewriteFile();
    fs.writeSync(2, `[shift] 压缩到第 ${level} 级：${before} → ${messages.length} 条，约 ${estimateTokens(messages)} tokens\n`);
    return true;
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
    if (shift.compact) await shift.compact();
    return reply;
  };
  think.shift = shift;
  return think;
}

module.exports = { createShift, createPersistentShift, createSessionShift, wrapThink, estimateTokens, compactMessages, compactMessage, compactWithModel, scoreMessage, COMPACT_PROMPT };
