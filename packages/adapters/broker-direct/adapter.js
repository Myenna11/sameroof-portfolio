#!/usr/bin/env node
// 同屋 · 适配器 · broker-direct：不夹 CLI，直接经 Unix socket 调凭证 broker 的 OpenAI 兼容接口。住户拿不到任何真 key。
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const { open, run, RUN } = require('../lib/room');
const ROOM = process.argv[2] || '检索员';
const R = open(ROOM);
const tokenPath = path.join(RUN, 'tokens', R.room.id);
if (!fs.existsSync(tokenPath)) { console.error(`${ROOM} 没有 broker token：${tokenPath}。让户主签一个：sameroof-broker token issue ${R.room.id} ...`); process.exit(2); }
const brokerToken = fs.readFileSync(tokenPath, 'utf8').trim();
const SOCK = path.join(RUN, 'broker.sock');
function think(system, user, signal) {
  const body = JSON.stringify({ model: R.room.model.id, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream: false, max_tokens: 4000, thinking: { type: 'enabled', effort: 'low' } });
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCK, path: '/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer ${brokerToken}`, 'content-type': 'application/json', 'x-sameroof-purpose': 'interactive', 'x-sameroof-credential': R.room.model.auth.credential } }, res => {
      let s = ''; res.on('data', c => s += c); res.on('end', () => { try { const j = JSON.parse(s); if (res.statusCode !== 200) return reject(new Error(`broker ${res.statusCode}: ${s.slice(0, 200)}`)); const ch = j.choices[0]; fs.writeSync(2, `[broker] finish=${ch.finish_reason} usage=${JSON.stringify(j.usage || {})} content_len=${(ch.message.content || '').length} reasoning_len=${(ch.message.reasoning_content || '').length}\n`); R.lastUsage = j.usage || null; resolve(ch.message.content); } catch (e) { reject(new Error('broker 回了怪东西: ' + s.slice(0, 200))); } });
    }); req.on('error', reject);
    if (signal) signal.addEventListener('abort', () => req.destroy(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || 'aborted'))), { once: true });
    req.write(body); req.end();
  });
}
run(R.room.name, 'broker-direct', think, { dry: process.argv.includes('--dry'), once: process.argv.includes('--once') });
