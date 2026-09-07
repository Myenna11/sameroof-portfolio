// 同屋 · 一班的对话累积（V2-1A）：进程活着这一班里，system 只发一次，之后 user/assistant 轮流往后接，
// 让上游的 prompt cache 能命中前缀。先做内存版：进程起来是空的，退出不落盘。
'use strict';
function createShift() {
  const messages = [];
  return {
    messages,
    open(system, user) {                                            // 这一轮接进去，返回要发的整包（就是 messages 本身）
      if (!messages.length) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: user });
      return messages;
    },
    commit(reply) { messages.push({ role: 'assistant', content: reply }); },
    retract() { if (messages.length && messages[messages.length - 1].role === 'user') messages.pop(); },   // 出错/回空：把刚才那条 user 撤回，别留下没人接的话
  };
}
// call(messages, signal) → reply 文本。包成 room.js 要的 think(system, user, signal)。
// system 和这一班开头那条不一样（比如睡前写便条那次）→ 当另一个话头，一次性发，不进这一班。
function wrapThink(call, shift = createShift()) {
  const think = async (system, user, signal) => {
    if (shift.messages.length && shift.messages[0].content !== system) return call([{ role: 'system', content: system }, { role: 'user', content: user }], signal);
    const messages = shift.open(system, user);
    let reply;
    try { reply = await call(messages, signal); } catch (e) { shift.retract(); throw e; }
    if (reply == null || !String(reply).trim()) { shift.retract(); return reply; }
    shift.commit(reply);
    return reply;
  };
  think.shift = shift;
  return think;
}
module.exports = { createShift, wrapThink };
