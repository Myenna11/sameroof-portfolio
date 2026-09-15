#!/usr/bin/env node
// 同屋 · 缓存探针（V2-CACHE-PROBE）：经 broker 用某住户的 token 对上游发"逐字节相同"的请求，隔不同秒数再发，读 usage.cached_tokens，
// 量出这家 provider 的：①最小可命中前缀 ②TTL ③连续两次是否必命中 ④改 max_tokens 会不会破缓存。
// 用法：node cache-probe.js <房间名> [--sizes 2500,6000] [--gaps 30,120,240,360,480,600,900] [--out state/cache-probe]
// 每个 size 一条独立血统（内容不同互不干扰），并行跑；每条血统按 gaps 顺序：热身 → 等 gap[i] → 探一次 → 等 gap[i+1] → …
// 注意：探针本身会刷新缓存，所以"间隔"永远是距上一次请求的间隔——这正是我们要的 TTL 定义。
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const { open, RUN, HOUSE } = require('../lib/room');
const args = process.argv.slice(2); const ROOM = args.find(a => !a.startsWith('--'));
if (!ROOM) { console.error('usage: node cache-probe.js <room-name> [--flags]'); process.exit(2); }
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const sizes = String(opt('sizes', '2500,6000')).split(',').map(Number);
const gaps = String(opt('gaps', '30,120,240,360,480,600,900')).split(',').map(Number);
const outDir = path.resolve(HOUSE, opt('out', 'state/cache-probe')); fs.mkdirSync(outDir, { recursive: true });
const R = open(ROOM);
const token = fs.readFileSync(path.join(RUN, 'tokens', R.room.id), 'utf8').trim();
const SOCK = path.join(RUN, 'broker.sock');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outFile = path.join(outDir, `${stamp}-${R.room.id}.jsonl`);
const log = o => { const line = JSON.stringify({ ts: new Date().toISOString(), ...o }); fs.appendFileSync(outFile, line + '\n'); console.log(line); };

// 稳定的合成前缀：同一血统内逐字节相同；不同 size 用不同种子，避免血统间互相命中
function buildPrefix(size, seed) {
  const para = `这是同屋缓存探针的填充段落（血统 ${seed}）。它的唯一作用是把前缀撑到目标长度，内容没有任何意义，模型不需要理解它。`;
  let s = ''; let i = 0; while (s.length < size * 2) { s += `[${seed}-${i++}] ${para}\n`; }   // 字符/2 粗估 token
  return s;
}
function call(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ socketPath: SOCK, path: '/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-sameroof-purpose': 'interactive', 'x-sameroof-credential': R.room.model.auth.credential } }, res => {
      let s = ''; res.on('data', c => s += c); res.on('end', () => { try { const j = JSON.parse(s); if (res.statusCode !== 200) return reject(new Error(`broker ${res.statusCode}: ${s.slice(0, 200)}`)); resolve(j.usage || {}); } catch (e) { reject(new Error('怪响应 ' + s.slice(0, 200))); } });
    }); req.on('error', reject); req.write(data); req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function lineage(size) {
  const seed = 'L' + size;
  const messages = [{ role: 'system', content: buildPrefix(size, seed) }, { role: 'user', content: '只回一个字：好。' }];
  const body = { model: R.room.model.id, messages, stream: false, max_tokens: 16, thinking: { type: 'enabled', effort: 'low' } };
  let last = Date.now();
  const shot = async (label, b = body) => {
    const t0 = Date.now(); const gapS = Math.round((t0 - last) / 1000);
    try { const u = await call(b); last = Date.now();
      log({ lineage: seed, label, gap_s: gapS, prompt_tokens: u.prompt_tokens, cached_tokens: u.cached_tokens ?? (u.prompt_tokens_details || {}).cached_tokens ?? null, completion_tokens: u.completion_tokens, ms: last - t0 }); }
    catch (e) { last = Date.now(); log({ lineage: seed, label, gap_s: gapS, error: e.message }); }
  };
  await shot('warm');                                // 建缓存
  await sleep(5000); await shot('immediate');        // 5 秒后：连续是否必命中（也验异步写入延迟）
  for (const g of gaps) { await sleep(g * 1000); await shot(`gap${g}`); }
  // 改 max_tokens 会不会破缓存（permafrost 说 DeepSeek 会；智谱未知）
  await sleep(5000); await shot('max_tokens_32', { ...body, max_tokens: 32 });
  await sleep(5000); await shot('back_to_16');
}
(async () => {
  log({ event: 'start', room: R.room.id, model: R.room.model.id, sizes, gaps, out: outFile });
  await Promise.all(sizes.map(lineage));
  log({ event: 'done' });
})().catch(e => { log({ event: 'fatal', error: e.message }); process.exit(1); });
