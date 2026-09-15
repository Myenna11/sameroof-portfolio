#!/usr/bin/env node
// 同屋 · 适配器 · broker-direct：不夹 CLI，直接经 Unix socket 调凭证 broker 的 OpenAI 兼容接口。住户拿不到任何真 key。
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const { open, run, RUN, HOUSE } = require('../lib/room');
const { wrapThink, createPersistentShift, COMPACT_PROMPT } = require('../lib/shift-messages');
const ROOM = process.argv[2] || '检索员';
const R = open(ROOM);
const tokenPath = path.join(RUN, 'tokens', R.room.id);
if (!fs.existsSync(tokenPath)) { console.error(`${ROOM} 没有 broker token：${tokenPath}。让户主签一个：sameroof-broker token issue ${R.room.id} ...`); process.exit(2); }
const readToken = () => fs.readFileSync(tokenPath, 'utf8').trim();
const SOCK = path.join(RUN, 'broker.sock');
// V2-W8：持久化 shift——JSONL 落盘，进程重启从文件恢复，sleep 时归档。
const shiftPath = path.join(HOUSE, 'state', `shift-${R.room.id}.jsonl`);
// 阈值：room.yaml 的 model.context_window（token 数）有就用，没有默认 60k；压缩在 70% 处触发
// 第三级压缩复用 call()：单发一条 compact prompt，不进这一班
const shift = createPersistentShift(shiftPath, {
  maxTokens: Number((R.room.model || {}).context_window) || 60000,
  keepTurns: Number((R.room.model || {}).keep_turns) || 12,
  compactFn: async dialogue => { const r = await call([{ role: 'system', content: COMPACT_PROMPT }, { role: 'user', content: dialogue }], null, readToken()); return (r && r.text) || ''; },
});
const think = wrapThink(async (messages, signal) => {
  try { return await call(messages, signal, readToken()); }
  catch (e) { if (!/broker 401/.test(String(e.message))) throw e; fs.writeSync(2, `[broker] 401，重读 token 再试一次\n`); return call(messages, signal, readToken()); }
}, shift);
function call(messages, signal, brokerToken, opts = {}) {
  const purpose = opts.purpose || 'interactive';
  const body = JSON.stringify({ model: R.room.model.id, messages, stream: false, max_tokens: opts.maxTokens || 4000, thinking: { type: 'enabled', effort: 'low' } });
  fs.writeSync(2, `[broker] 发 ${messages.length} 条消息（这一班累积）\n`);
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCK, path: '/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer ${brokerToken}`, 'content-type': 'application/json', 'x-sameroof-purpose': purpose, 'x-sameroof-credential': R.room.model.auth.credential, ...(opts.runId ? { 'x-sameroof-run': opts.runId } : {}) } }, res => {
      let s = ''; res.on('data', c => s += c); res.on('end', () => { try { const j = JSON.parse(s); if (res.statusCode !== 200) return reject(new Error(`broker ${res.statusCode}: ${s.slice(0, 200)}`)); const ch = j.choices[0]; fs.writeSync(2, `[broker] finish=${ch.finish_reason} usage=${JSON.stringify(j.usage || {})} content_len=${(ch.message.content || '').length} reasoning_len=${(ch.message.reasoning_content || '').length}\n`); resolve({ text: ch.message.content, usage: j.usage || null }); } catch (e) { reject(new Error('broker 回了怪东西: ' + s.slice(0, 200))); } });
    }); req.on('error', reject);
    if (signal) signal.addEventListener('abort', () => req.destroy(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || 'aborted'))), { once: true });
    req.write(body); req.end();
  });
}
// One-shot model call with the SAME broker socket/token/model, but NO persistent shift:
// the caller owns `messages`; nothing is appended to state/shift-<id>.jsonl. For subruns (design §4.2, G4).
// purpose must be in the token's `purposes` (broker rejects otherwise) — default 'subagent'.
async function callOnce(messages, signal, opts = {}) {
  const o = { purpose: 'subagent', ...opts };
  try { return await call(messages, signal, readToken(), o); }
  catch (e) { if (!/broker 401/.test(String(e.message))) throw e; return call(messages, signal, readToken(), o); }
}
module.exports = { think, callOnce, call, shift, shiftPath };
if (require.main === module) run(R.room.name, 'broker-direct', think, { dry: process.argv.includes('--dry'), once: process.argv.includes('--once') });
