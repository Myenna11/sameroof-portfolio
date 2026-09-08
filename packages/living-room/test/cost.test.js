// V2-COST：GET /cost?days= 按天 × 住户聚合 state/runs/*.jsonl 的 usage；人 only；天按 house.timezone 切；没 usage 的醒来计 wakes 不计 tokens。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), http = require('node:http'), os = require('node:os'), path = require('node:path');
const test = require('node:test');
const { createLivingRoom } = require('../server');
const request = (port, p, o = {}) => new Promise((resolve, reject) => { const req = http.request({ hostname: '127.0.0.1', port, path: p, method: 'GET', headers: { authorization: 'Bearer ' + o.token } }, res => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => { let v = Buffer.concat(c).toString(); try { v = JSON.parse(v); } catch {} resolve({ status: res.statusCode, body: v }); }); }); req.on('error', reject); req.end(); });

test('GET /cost：按天聚合 input/output/cached/wakes/calls，缺 usage 只计 wakes，agent 403', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-cost-'));
  for (const [n, y] of [['甲', 'id: resident_alpha_01\nname: 甲\nspecies: human\n'], ['乙', 'id: resident_beta_01\nname: 乙\nspecies: agent\nruntime: broker-direct\n'], ['丙', 'id: resident_gamma_01\nname: 丙\nspecies: agent\nruntime: pi\n']]) { fs.mkdirSync(path.join(root, 'rooms', n), { recursive: true }); fs.writeFileSync(path.join(root, 'rooms', n, 'room.yaml'), y); }
  fs.mkdirSync(path.join(root, 'apps', 'house'), { recursive: true }); fs.writeFileSync(path.join(root, 'apps', 'house', 'index.html'), '<!doctype html>');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'house.yaml'), path.join(root, 'house.yaml'));
  fs.mkdirSync(path.join(root, 'state', 'runs'), { recursive: true });
  const now = Date.now(), day = 86400000;
  const rec = (ts, extra) => JSON.stringify({ id: 'run_x', resident_id: 'resident_beta_01', ts: new Date(ts).toISOString(), status: 'said', model_calls: 1, ...extra }) + '\n';
  fs.writeFileSync(path.join(root, 'state', 'runs', 'resident_beta_01.jsonl'),
    rec(now, { usage: { prompt_tokens: 1000, completion_tokens: 100, cached_tokens: 400 } }) +
    rec(now - 1000, { usage: { input_tokens: 500, output_tokens: 50 } }) +           // Anthropic 字段名也认
    rec(now - day, { usage: { prompt_tokens: 2000, completion_tokens: 200, cached_tokens: 0 } }) +
    rec(now - 10 * day, { usage: { prompt_tokens: 99999, completion_tokens: 9 } }) +  // 7 天外，不计
    rec(now - 2 * day, {}));                                                        // 没 usage：wakes 计，tokens 不计
  fs.writeFileSync(path.join(root, 'state', 'runs', 'resident_gamma_01.jsonl'), JSON.stringify({ id: 'run_y', resident_id: 'resident_gamma_01', ts: new Date(now).toISOString(), status: 'silent', model_calls: 1 }) + '\n');
  const room = createLivingRoom({ houseDir: root, runDir: path.join(root, 'run'), dataDir: path.join(root, 'state'), port: 0 });
  try {
    const port = (await room.listen()).port;
    const alpha = room.tokenStore.issue('resident_alpha_01').token, beta = room.tokenStore.issue('resident_beta_01').token;
    assert.equal((await request(port, '/cost', { token: beta })).status, 403);
    assert.equal((await request(port, '/cost?days=0', { token: alpha })).status, 400);
    const r = await request(port, '/cost?days=7', { token: alpha });
    assert.equal(r.status, 200); assert.equal(r.body.days.length, 7); assert.equal(r.body.source, 'state/runs');
    const b = r.body.residents.find(x => x.resident === '乙'); const g = r.body.residents.find(x => x.resident === '丙');
    assert.equal(b.runtime, 'broker-direct'); assert.equal(g.runtime, 'pi');
    assert.deepEqual({ ...b.total }, { wakes: 4, calls: 4, with_usage: 3, input: 3500, output: 350, cached: 400, cache_creation: 0 });
    const todayRow = b.days[6]; assert.equal(todayRow.input, 1500); assert.equal(todayRow.cached, 400); assert.equal(todayRow.wakes, 2);
    assert.equal(b.days[5].input, 2000); assert.equal(b.days[4].wakes, 1); assert.equal(b.days[4].with_usage, 0);
    assert.deepEqual({ ...g.total }, { wakes: 1, calls: 1, with_usage: 0, input: 0, output: 0, cached: 0, cache_creation: 0 });
    assert.ok(!r.body.residents.some(x => x.resident === '甲'));
  } finally { await room.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('GET /cost 带 ledger 段：broker 报表拉到就合并住户名；拉不到只给 ledger_error 不炸', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-cost2-'));
  for (const [n, y] of [['甲', 'id: resident_alpha_01\nname: 甲\nspecies: human\n'], ['乙', 'id: resident_beta_01\nname: 乙\nspecies: agent\nruntime: broker-direct\n']]) { fs.mkdirSync(path.join(root, 'rooms', n), { recursive: true }); fs.writeFileSync(path.join(root, 'rooms', n, 'room.yaml'), y); }
  fs.mkdirSync(path.join(root, 'apps', 'house'), { recursive: true }); fs.writeFileSync(path.join(root, 'apps', 'house', 'index.html'), '<!doctype html>');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'house.yaml'), path.join(root, 'house.yaml'));
  let seen = null;
  const okClient = { daily: async q => { seen = q; return { days: ['d1'], timezone: q.tz, residents: [{ resident_id: 'resident_beta_01', days: [{ day: 'd1', requests: 3, tokens: 900, cached: 100 }], total: { requests: 3, tokens: 900, cached: 100 }, by_model: [] }] }; } };
  const badClient = { daily: async () => { const e = new Error('凭证没配'); e.code = 'REPORT-NOT-CONFIGURED'; throw e; } };
  for (const [client, check] of [[okClient, r => { assert.equal(r.ledger.residents[0].resident, '乙'); assert.equal(r.ledger.residents[0].total.tokens, 900); assert.equal(r.ledger_error, null); assert.equal(seen.days, 2); assert.ok(seen.tz); }], [badClient, r => { assert.equal(r.ledger, null); assert.equal(r.ledger_error.code, 'REPORT-NOT-CONFIGURED'); assert.equal(r.source, 'state/runs'); }]]) {
    const room = createLivingRoom({ houseDir: root, runDir: path.join(root, 'run'), dataDir: path.join(root, 'state-' + Math.random().toString(36).slice(2)), port: 0, reportClient: client });
    try { const port = (await room.listen()).port; const alpha = room.tokenStore.issue('resident_alpha_01').token;
      const r = await request(port, '/cost?days=2', { token: alpha }); assert.equal(r.status, 200); check(r.body);
    } finally { await room.close(); }
  }
  fs.rmSync(root, { recursive: true, force: true });
});
