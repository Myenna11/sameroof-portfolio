// V2-LEDGER：只读报表 /internal/report/daily——凭 report-client.token；按天×住户聚合；不吐 request 明细/token_id/凭证；tz 归天；缺凭证 503、错凭证 401。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), http = require('node:http'), os = require('node:os'), path = require('node:path');
const test = require('node:test');
const { BrokerStore, BrokerError } = require('../store');
const { LedgerReport } = require('../report');
const { createBroker } = require('../server');
const req = (socketPath, p, token) => new Promise((resolve, reject) => { const r = http.request({ socketPath, path: p, headers: token ? { authorization: 'Bearer ' + token } : {} }, res => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => { let v = Buffer.concat(c).toString(); try { v = JSON.parse(v); } catch {} resolve({ status: res.statusCode, json: v }); }); }); r.on('error', reject); r.end(); });

test('LedgerReport.daily：按天×住户聚合、tz 归天、by_model、空天补零、不含明细', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-report-'));
  try {
    const store = new BrokerStore({ home, enableMock: true });
    const tid = store.issueToken({ residentId: 'resident_agent_01', credentials: ['mock-cheap'], models: ['mock-chat'] }).id;   // ledger.token_id 有外键
    const ins = store.db.prepare('INSERT INTO ledger(request_id,ts,resident_id,token_id,credential_alias,provider,model,purpose,reserve_tokens,actual_tokens,estimated,status,http_status,latency_ms,cached_tokens,cache_creation_tokens) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const now = Date.parse('2026-09-08T03:00:00Z');   // 上海 11:00
    ins.run('r1', '2026-09-08T02:00:00Z', 'researcher', tid, 'shared-cheap', 'zhipu', 'glm-5.3-flash', 'interactive', 100, 6805, 0, 'complete', 200, 3000, 0, 0);
    ins.run('r2', '2026-09-07T17:30:00Z', 'researcher', tid, 'shared-cheap', 'zhipu', 'glm-5.3-flash', 'interactive', 100, 3734, 0, 'complete', 200, 1000, 500, 0);   // UTC 9/7 晚 = 上海 9/8 凌晨
    ins.run('r3', '2026-09-07T10:00:00Z', 'researcher', tid, 'shared-cheap', 'zhipu', 'glm-5.3-flash', 'interactive', 100, 1000, 1, 'upstream_error', 502, 200, null, null);
    ins.run('r4', '2026-09-06T10:00:00Z', 'builder', tid, 'example-model', 'kimi-coding', 'k3', 'interactive', 100, 800, 0, 'complete', 200, 500, 100, 20);
    ins.run('r5', '2026-08-20T10:00:00Z', 'researcher', tid, 'shared-cheap', 'zhipu', 'glm-5.3-flash', 'interactive', 100, 99999, 0, 'complete', 200, 1, 0, 0);   // 范围外
    const rep = new LedgerReport({ store });
    const d = rep.daily({ days: 3, tz: 'Asia/Shanghai', now });
    assert.deepEqual(d.days, ['2026-09-06', '2026-09-07', '2026-09-08']); assert.equal(d.timezone, 'Asia/Shanghai');
    const z = d.residents.find(r => r.resident_id === 'researcher'), k = d.residents.find(r => r.resident_id === 'builder');
    assert.equal(d.residents[0].resident_id, 'researcher');   // tokens 多的在前
    assert.deepEqual(z.days.map(x => x.requests), [0, 1, 2]);
    assert.deepEqual(z.days[2], { day: '2026-09-08', requests: 2, ok: 2, errors: 0, tokens: 10539, cached: 500, cache_creation: 0, estimated: 0, latency_avg_ms: 2000 });
    assert.deepEqual(z.days[1], { day: '2026-09-07', requests: 1, ok: 0, errors: 1, tokens: 1000, cached: 0, cache_creation: 0, estimated: 1, latency_avg_ms: 200 });
    assert.deepEqual(z.total, { requests: 3, ok: 2, errors: 1, tokens: 11539, cached: 500, cache_creation: 0, estimated: 1 });
    assert.deepEqual(z.by_model, [{ provider: 'zhipu', model: 'glm-5.3-flash', requests: 3, tokens: 11539, cached: 500 }]);
    assert.deepEqual(k.days.map(x => x.tokens), [800, 0, 0]);
    for (const r of d.residents) for (const key of Object.keys(r)) assert.ok(!/request_id|token_id|credential|api_key/.test(key));
    assert.throws(() => rep.daily({ tz: 'Mars/Olympus' }), e => e instanceof BrokerError && e.code === 'REPORT-TZ-INVALID');
    assert.equal(rep.daily({ days: 999, now }).days.length, 90);
    store.close();
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('/internal/report/daily：缺凭证 503、错凭证 401、对凭证 200；init 二次要 --rotate', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-report-'));
  const store = new BrokerStore({ home, enableMock: true });
  const broker = createBroker({ store, socketPath: path.join(store.runDir, 'broker.sock') });
  await broker.listen();
  try {
    const rep = new LedgerReport({ store });
    assert.equal((await req(broker.socketPath, '/internal/report/daily', 'x')).status, 503);
    assert.equal(rep.status().configured, false);
    rep.initialize();
    assert.equal(rep.status().configured, true);
    assert.throws(() => rep.initialize(), e => e.code === 'REPORT-CREDENTIAL-EXISTS');
    const secret = fs.readFileSync(rep.clientTokenFile, 'utf8').trim();
    assert.ok(secret.startsWith('srr_') && secret.length > 40);
    assert.equal((fs.statSync(rep.clientTokenFile).mode & 0o777), 0o600);
    assert.equal((await req(broker.socketPath, '/internal/report/daily')).status, 401);
    assert.equal((await req(broker.socketPath, '/internal/report/daily', 'srr_wrong')).status, 401);
    // 住户 token 不能看报表
    const issued = store.issueToken({ residentId: 'resident_agent_01', credentials: ['mock-cheap'], models: ['mock-chat'] });
    assert.equal((await req(broker.socketPath, '/internal/report/daily', issued.secret)).status, 401);
    const ok = await req(broker.socketPath, '/internal/report/daily?days=2&tz=Asia/Shanghai', secret);
    assert.equal(ok.status, 200); assert.equal(ok.json.days.length, 2); assert.equal(ok.json.timezone, 'Asia/Shanghai'); assert.deepEqual(ok.json.residents, []);
    assert.equal((await req(broker.socketPath, '/internal/report/daily?tz=Nope/Nope', secret)).status, 400);
    rep.initialize(true); assert.notEqual(fs.readFileSync(rep.clientTokenFile, 'utf8').trim(), secret);
    assert.equal((await req(broker.socketPath, '/internal/report/daily', secret)).status, 401);   // 旧的作废
  } finally { await broker.close(); store.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
