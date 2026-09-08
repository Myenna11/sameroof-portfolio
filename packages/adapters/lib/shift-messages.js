// 同屋 · 一班的对话累积（V2-1A → V2-W8）：进程活着这一班里，system 只发一次，之后 user/assistant 往后接，
// 让上游的 prompt cache 能命中前缀。V2-W8 加 JSONL 落盘：进程重启后从文件恢复，一班结束时归档。
'use strict';
const fs = require('fs');
const path = require('path');

// ---- 纯内存版（测试、一次性调用、claude-code 暂用） ----
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

// ---- 持久化版（broker-direct 用）：每条消息 append 一行 JSONL，重启从文件恢复 ----
// 文件格式：每行一个 JSON，{ op, role?, content?, ts }
//   op='msg'  → 一条消息（role + content）
//   op='retract' → 撤回最后一条 user
// archive() 把当前文件移到 <dir>/shifts/<date>-<resident>.jsonl，清空内存。
function createPersistentShift(filePath) {
  const messages = [];
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // ---- 恢复：读文件重建 messages ----
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

// call(messages, signal) → reply：字符串，或 { text, usage }。包成 room.js 要的 think(system, user, signal)。
const textOf = r => (r && typeof r === 'object') ? (r.text == null ? '' : String(r.text)) : (r == null ? '' : String(r));

// system 和这一班开头那条不一样（比如睡前写便条那次）→ 当另一个话头，一次性发，不进这一班。
function wrapThink(call, shift = createShift()) {
  const think = async (system, user, signal) => {
    if (shift.messages.length && shift.messages[0].content !== system) return call([{ role: 'system', content: system }, { role: 'user', content: user }], signal);
    const messages = shift.open(system, user);
    let reply;
    try { reply = await call(messages, signal); } catch (e) { shift.retract(); throw e; }
    const text = textOf(reply);
    if (!text.trim()) { shift.retract(); return reply; }
    shift.commit(text);
    return reply;
  };
  think.shift = shift;
  return think;
}

module.exports = { createShift, createPersistentShift, wrapThink };
