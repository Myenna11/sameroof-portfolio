// 同屋 · 上下文拼装的纯函数：打分挑选、摘要帧、工具留壳。room.js 调用；不碰盘不碰网，可单测。
// 三条规则：
//   1. 召回块【我记得的事】放 user 侧开头，不进 system——system 只放一班内稳定的东西（人设、规矩、交接信、惦记本、小本），好命中 prompt cache。
//   2. "刚才的话 / 私信往来"不再"最近 N 条从旧往新截"，而是候选池打分、取最高 N 条、按时间重排；字数超了从分低的丢，不是从旧的丢。
//   3. 工具留壳：meta.kind === 'tool'（或文本以 [工具 开头）的消息，无论在刚才的话、私信往来还是收件箱里，一律只显示 [工具调用: X]，结果不展开——
//      模型要看结果，等网关"结果投回收件箱"那条正文消息（那是普通消息）。
// 打分表（scoreRecent）：@ 了我 +3；我自己说的 +2（保住"我已经回过"）；发言人在本次 inbox 里 +2；人类 +1；私信 +1；距现在每过 1 小时 -0.5（下限 -3）。
'use strict';

const byName = (id, members) => ((members || []).find(m => m.id === id) || {}).name || id;
const isTool = m => !!(m && ((m.meta && m.meta.kind === 'tool') || /^\s*\[工具/.test(String(m.text || ''))));
// 名字：meta.tool 优先，否则取方括号里去掉"工具调用/工具结果/工具"和冒号后的第一个词
function toolName(m) {
  if (m.meta && m.meta.tool) return String(m.meta.tool);
  const inside = (String(m.text || '').match(/^\s*\[([^\]]*)\]?/) || [])[1] || '';
  const w = inside.replace(/^工具(?:调用|结果)?\s*[:：]?\s*/, '').trim().split(/\s+/)[0];
  return w || '?';
}
// 摘要帧的正文：文字原样（超 maxChars 截断加 …；maxChars<=0 不截）；工具消息压成一行
function frameBody(m, maxChars = 400) {
  if (isTool(m)) return `[工具调用: ${toolName(m)}]`;
  const t = String(m.text || '');
  return maxChars > 0 && t.length > maxChars ? t.slice(0, maxChars) + '…' : t;
}
// 一整行：[时间] 名字（我自己）(标签)：正文。ts='short' 只有 HH:MM，'long' 带月日。名字优先用服务端给的 m.from（inbox 有），否则按 members 查
function renderFrame(m, { roomId, members, ts = 'short', maxChars = 400, tag = '' } = {}) {
  const stamp = ts === 'long' ? String(m.ts || '').slice(5, 16).replace('T', ' ') : String(m.ts || '').slice(11, 16);
  const who = m.from || byName(m.from_id, members);
  return `[${stamp}] ${who}${m.from_id === roomId ? '（我自己）' : ''}${tag}：${frameBody(m, maxChars)}`;
}
function scoreRecent(m, { roomId, inbox = [], members = [], now = Date.now() } = {}) {
  let s = 0;
  if ((m.mentions || []).includes(roomId)) s += 3;
  if (m.from_id === roomId) s += 2;
  if (inbox.some(x => x.from_id === m.from_id)) s += 2;
  if ((members.find(x => x.id === m.from_id) || {}).species === 'human') s += 1;
  if (m.kind === 'dm') s += 1;
  const age = +new Date(now) - Date.parse(m.ts);
  if (age > 0) s += Math.max(-3, -0.5 * Math.floor(age / 3600000));
  return s;
}
// 从候选里挑：按分取最高 limit 条（同分新的优先），渲染后总字数超 maxChars 从分低的丢，最后按时间重排。
// 返回 { lines, picked, scored }，scored 是全部候选按分降序的 [{id, score}]（事后看为什么选了这些）。
function pickRecent(msgs, { limit = 20, maxChars = 0, score, render } = {}) {
  const all = (msgs || []).map((m, i) => ({ m, i, score: score(m), line: render(m) }));
  const byScore = [...all].sort((a, b) => b.score - a.score || b.i - a.i);
  const take = byScore.slice(0, Math.max(0, limit));
  let used = take.reduce((a, x) => a + x.line.length, 0);
  while (take.length && maxChars > 0 && used > maxChars) used -= take.pop().line.length;
  const tkey = x => (x.m.seq != null ? Number(x.m.seq) : NaN);
  take.sort((a, b) => { const sa = tkey(a), sb = tkey(b); if (!Number.isNaN(sa) && !Number.isNaN(sb) && sa !== sb) return sa - sb; const d = Date.parse(a.m.ts) - Date.parse(b.m.ts); return (Number.isNaN(d) ? 0 : d) || a.i - b.i; });
  return { lines: take.map(x => x.line), picked: take.map(x => x.m), scored: byScore.map(x => ({ id: x.m.id, score: x.score })) };
}
module.exports = { isTool, toolName, frameBody, renderFrame, scoreRecent, pickRecent };
