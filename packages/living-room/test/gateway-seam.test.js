'use strict';
// 客厅 × 能力网关接缝（docs/GATEWAY.md §3）：执行型审批摘要、权威决定流、结果投回、service token。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const jcs = require('@sameroof/jcs');
const { createLivingRoom } = require('../server');

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const req = http.request({ hostname: options.hostname || '127.0.0.1', port, path: pathname, method: options.method || 'GET', headers: {
      ...(options.token ? { authorization: 'Bearer ' + options.token } : {}),
      ...(options.headers || {}),
      ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {})
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let value = text;
        try { value = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: value });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-gw-'));
  fs.mkdirSync(path.join(root, 'rooms', '甲'), { recursive: true });
  fs.mkdirSync(path.join(root, 'rooms', '乙'), { recursive: true });
  fs.mkdirSync(path.join(root, 'rooms', '丙'), { recursive: true });
  fs.mkdirSync(path.join(root, 'apps', 'house'), { recursive: true });
  fs.writeFileSync(path.join(root, 'rooms', '甲', 'room.yaml'), 'id: resident_alpha_01\nname: 甲\nspecies: human\n');
  fs.writeFileSync(path.join(root, 'rooms', '乙', 'room.yaml'), 'id: resident_beta_01\nname: 乙\nspecies: agent\n');
  fs.writeFileSync(path.join(root, 'rooms', '丙', 'room.yaml'), 'id: resident_gamma_01\nname: 丙\nspecies: agent\n');
  fs.writeFileSync(path.join(root, 'apps', 'house', 'index.html'), '<!doctype html>');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'house.yaml'), path.join(root, 'house.yaml'));
  return root;
}

const SERVICE_TOKEN = 'gw-service-' + 'a1b2c3d4e5f6'.repeat(4);
const params = { root_id: 'own-room', path: 'notes/today.md', content: '今天写点东西\n', mode: 'replace' };

test('执行型审批：摘要不一致拒、缺一半拒、同 request 二次拒、legacy 共存；决定流按 seq 补读；结果投回幂等且只到申请住户', async () => {
  const root = fixture();
  const tokenFile = path.join(root, 'run', 'gateway-service.token');
  const room = createLivingRoom({ houseDir: root, runDir: path.join(root, 'run'), dataDir: path.join(root, 'state'), port: 0, approvalLimit: 50, gatewayServiceTokenFile: tokenFile });
  try {
    const port = (await room.listen()).port;
    const alpha = room.tokenStore.issue('resident_alpha_01').token;
    const beta = room.tokenStore.issue('resident_beta_01').token;
    const gamma = room.tokenStore.issue('resident_gamma_01').token;
    const svc = { token: SERVICE_TOKEN };

    // ---- service token：文件不存在 → 两个内部接口一律 503（fail closed）
    assert.equal((await request(port, '/internal/gateway/approval-results', svc)).body.error.code, 'GW-SERVICE-TOKEN-MISSING');
    assert.equal((await request(port, '/internal/gateway/approval-results', svc)).status, 503);
    assert.equal((await request(port, '/internal/gateway/results', { ...svc, method: 'POST', body: {} })).status, 503);
    fs.writeFileSync(tokenFile, SERVICE_TOKEN + '\n', { mode: 0o600 });
    fs.chmodSync(tokenFile, 0o644);                                            // 权限太开也不行
    assert.equal((await request(port, '/internal/gateway/approval-results', svc)).body.error.code, 'GW-SERVICE-TOKEN-UNSAFE');
    fs.chmodSync(tokenFile, 0o600);
    // 住户 token / 没 token / 错 token → 403；经反代（带 cf-connecting-ip）→ 403
    assert.equal((await request(port, '/internal/gateway/approval-results', { token: alpha })).status, 403);
    assert.equal((await request(port, '/internal/gateway/approval-results', { token: alpha })).body.error.code, 'GW-AUTH-DENIED');
    assert.equal((await request(port, '/internal/gateway/approval-results', { token: beta })).status, 403);
    assert.equal((await request(port, '/internal/gateway/approval-results')).status, 403);
    assert.equal((await request(port, '/internal/gateway/approval-results', { token: SERVICE_TOKEN.slice(0, -1) + 'X' })).status, 403);
    assert.equal((await request(port, '/internal/gateway/approval-results', { ...svc, headers: { 'cf-connecting-ip': '203.0.113.9' } })).body.error.code, 'GW-NOT-LOOPBACK');
    // service token 反过来也进不了住户接口
    assert.equal((await request(port, '/me', svc)).status, 401);
    const empty = await request(port, '/internal/gateway/approval-results?after_seq=0&limit=10', svc);
    assert.deepEqual(empty.body, { items: [], next_seq: 0 });
    assert.equal((await request(port, '/internal/gateway/approval-results?limit=0', svc)).status, 400);
    assert.equal((await request(port, '/internal/gateway/approval-results?limit=101', svc)).status, 400);

    // ---- 执行型审批创建
    const digest = jcs.digest(params);
    const bad = await request(port, '/approval', { method: 'POST', token: beta, body: { action: 'core.fs.write', params, params_digest: 'f'.repeat(64), gateway_request_id: 'req_bad000001', ttl_seconds: 600 } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'APPROVAL-DIGEST-MISMATCH');
    assert.equal((await request(port, '/approval', { method: 'POST', token: beta, body: { action: 'core.fs.write', params, gateway_request_id: 'req_half000001' } })).body.error.code, 'APPROVAL-DIGEST-INVALID');
    assert.equal((await request(port, '/approval', { method: 'POST', token: beta, body: { action: 'core.fs.write', params, params_digest: digest } })).body.error.code, 'APPROVAL-REQUEST-ID-INVALID');
    assert.equal((await request(port, '/approval', { method: 'POST', token: beta, body: { action: 'core.fs.write', params: [1], params_digest: digest, gateway_request_id: 'req_arr0000001' } })).body.error.code, 'APPROVAL-PARAMS-INVALID');
    assert.equal((await request(port, '/history', { token: alpha })).body.length, 0, '拒掉的不该创建任何东西');
    // 键序不同的 params 也应算出同一摘要（JCS 的意义）
    const shuffled = { mode: params.mode, content: params.content, path: params.path, root_id: params.root_id };
    const ok = await request(port, '/approval', { method: 'POST', token: beta, body: { action: 'core.fs.write', params: shuffled, params_digest: digest, gateway_request_id: 'req_0000000001', ttl_seconds: 600 } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.digest_kind, 'jcs');
    assert.equal(ok.body.gateway_request_id, 'req_0000000001');
    assert.equal(ok.body.params_digest, digest);
    const dup = await request(port, '/approval', { method: 'POST', token: beta, body: { action: 'core.fs.write', params, params_digest: digest, gateway_request_id: 'req_0000000001' } });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'APPROVAL-REQUEST-DUPLICATE');
    const legacy = await request(port, '/approval', { method: 'POST', token: beta, body: { action: 'core.exec', params: { raw: 'ls' } } });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.digest_kind, 'legacy');
    assert.equal(legacy.body.gateway_request_id, null);
    const second = await request(port, '/approval', { method: 'POST', token: gamma, body: { action: 'core.fs.read', params: { root_id: 'own-room', path: 'a.md' }, params_digest: jcs.digest({ path: 'a.md', root_id: 'own-room' }), gateway_request_id: 'req_0000000002' } });
    assert.equal(second.status, 200);
    const hist = (await request(port, '/history', { token: alpha })).body;
    const askMsg = hist.find(m => m.meta && m.meta.approval_id === ok.body.approval_id);
    assert.equal(askMsg.meta.gateway_request_id, 'req_0000000001');
    assert.equal(askMsg.meta.digest_kind, 'jcs');
    const askActivity = (await request(port, '/activity?kind=approval_request', { token: alpha })).body.find(a => a.meta.approval_id === ok.body.approval_id);
    assert.equal(askActivity.meta.gateway_request_id, 'req_0000000001');
    const detail = (await request(port, '/approval/' + ok.body.approval_id, { token: beta })).body;
    assert.equal(detail.gateway_request_id, 'req_0000000001');
    assert.deepEqual(detail.params, params);

    // ---- 决定：只有人；同一事务进决定流；legacy 不进流
    assert.equal((await request(port, '/approval/' + ok.body.approval_id, { method: 'POST', token: beta, body: { decision: 'allow' } })).status, 403);
    assert.equal((await request(port, '/internal/gateway/approval-results', svc)).body.items.length, 0, '没决定之前流里没东西');
    const allowed = await request(port, '/approval/' + ok.body.approval_id, { method: 'POST', token: alpha, body: { decision: 'allow' } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.decision, 'allowed');
    assert.equal(allowed.body.remember, 'once');
    assert.equal(allowed.body.decision_seq, 1);
    const legacyDecision = await request(port, '/approval/' + legacy.body.approval_id, { method: 'POST', token: alpha, body: { decision: 'deny' } });
    assert.equal(legacyDecision.status, 200);
    assert.equal(legacyDecision.body.decision_seq, null);
    assert.equal((await request(port, '/approval/' + second.body.approval_id, { method: 'POST', token: alpha, body: { decision: 'deny' } })).body.decision_seq, 2);
    assert.equal((await request(port, '/approval/' + ok.body.approval_id, { method: 'POST', token: alpha, body: { decision: 'allow' } })).status, 409, '决定一次');
    const stream = (await request(port, '/internal/gateway/approval-results?after_seq=0&limit=100', svc)).body;
    assert.equal(stream.items.length, 2);
    assert.equal(stream.next_seq, 2);
    assert.deepEqual(stream.items[0], {
      seq: 1, approval_id: ok.body.approval_id, gateway_request_id: 'req_0000000001', resident_id: 'resident_beta_01', action: 'core.fs.write',
      params_digest: digest, decision: 'allowed', remember: 'once', decided_by: 'resident_alpha_01', decided_at: allowed.body.decided_at, expires_at: ok.body.expires_at, single_use: true
    });
    assert.equal(stream.items[1].decision, 'denied');
    assert.equal(stream.items[1].gateway_request_id, 'req_0000000002');
    const page = (await request(port, '/internal/gateway/approval-results?after_seq=1&limit=1', svc)).body;
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].seq, 2);
    assert.equal(page.next_seq, 2);
    assert.deepEqual((await request(port, '/internal/gateway/approval-results?after_seq=2', svc)).body, { items: [], next_seq: 2 });
    assert.equal((await request(port, '/internal/gateway/approval-results?after_seq=0&limit=1', svc)).body.next_seq, 1);

    // ---- 结果投回
    const result = {
      request_id: 'req_0000000001', approval_id: ok.body.approval_id, resident_id: 'resident_beta_01', action: 'core.fs.write', status: 'succeeded',
      coverage: { executor: 'path-rules', network: 'denied', requested: ['own-room:notes/today.md'], completed: ['own-room:notes/today.md'] },
      next: { kind: 'none' },
      summary: '已写入 notes/today.md（token: abcdefgh12345678 Authorization: Bearer xyz123456789 别泄露）',
      details: { bytes_written: 123, sha256: 'ab'.repeat(32), token: 'should-not-leak-000', nested: { api_key: 'nope-nope-nope' } }
    };
    assert.equal((await request(port, '/internal/gateway/results', { method: 'POST', token: beta, body: result })).status, 403);
    assert.equal((await request(port, '/internal/gateway/results', { ...svc, method: 'POST', body: { ...result, action: 'core.exec' } })).body.error.code, 'GW-RESULT-MISMATCH');
    assert.equal((await request(port, '/internal/gateway/results', { ...svc, method: 'POST', body: { ...result, resident_id: 'resident_gamma_01' } })).status, 409);
    assert.equal((await request(port, '/internal/gateway/results', { ...svc, method: 'POST', body: { ...result, approval_id: 'apr_' + '0'.repeat(24) } })).status, 409);
    assert.equal((await request(port, '/internal/gateway/results', { ...svc, method: 'POST', body: { ...result, request_id: 'req_nobody00001' } })).body.error.code, 'GW-RESULT-UNKNOWN-REQUEST');
    assert.equal((await request(port, '/internal/gateway/results', { ...svc, method: 'POST', body: { ...result, status: 'done' } })).body.error.code, 'GW-RESULT-INVALID');
    assert.equal((await request(port, '/internal/gateway/results', { ...svc, method: 'POST', body: { ...result, next: { kind: 'whatever' } } })).body.error.code, 'GW-RESULT-INVALID');
    assert.equal((await request(port, '/history', { token: alpha })).body.filter(m => m.kind === 'result').length, 0, '拒掉的不投递');
    const first = await request(port, '/internal/gateway/results', { ...svc, method: 'POST', body: result });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.match(first.body.message_id, /^msg_[a-f0-9]{24}$/);
    assert.equal(first.body.duplicate, false);
    const again = await request(port, '/internal/gateway/results', { ...svc, method: 'POST', body: { ...result, summary: '重试时内容变了也不重投' } });
    assert.equal(again.status, 200);
    assert.equal(again.body.message_id, first.body.message_id);
    assert.equal(again.body.duplicate, true);
    // 只到申请住户的 inbox；文本脱敏；meta 完整
    const inboxBeta = (await request(port, '/inbox', { token: beta })).body;
    const delivered = inboxBeta.filter(m => m.kind === 'result');
    assert.equal(delivered.length, 1, '同 request_id 两次只投一条');
    assert.equal(delivered[0].id, first.body.message_id);
    assert.equal(delivered[0].from_id, 'house');
    assert.equal(delivered[0].from, '房子');
    assert.equal(delivered[0].to_id, 'resident_beta_01');
    assert.deepEqual(delivered[0].mentions, ['resident_beta_01']);
    assert.doesNotMatch(delivered[0].text, /abcdefgh12345678|xyz123456789/);
    assert.match(delivered[0].text, /已写入 notes\/today\.md/);
    assert.equal(delivered[0].meta.gateway_request_id, 'req_0000000001');
    assert.equal(delivered[0].meta.approval_id, ok.body.approval_id);
    assert.equal(delivered[0].meta.status, 'succeeded');
    assert.equal(delivered[0].meta.deliver, 'interrupt');
    assert.deepEqual(delivered[0].meta.next, { kind: 'none' });
    assert.equal(delivered[0].meta.coverage.executor, 'path-rules');
    assert.equal(delivered[0].meta.details.bytes_written, 123);
    assert.equal(delivered[0].meta.details.token, '[已脱敏]');
    assert.equal(delivered[0].meta.details.nested.api_key, '[已脱敏]');
    assert.equal((await request(port, '/inbox', { token: alpha })).body.filter(m => m.kind === 'result').length, 0);
    assert.equal((await request(port, '/inbox', { token: gamma })).body.filter(m => m.kind === 'result').length, 0);
    for (const t of [alpha, gamma, beta]) {
      assert.equal((await request(port, '/history', { token: t })).body.filter(m => m.kind === 'result').length, 0, '/history 不公开 result');
      assert.equal((await request(port, '/history?before=' + Number.MAX_SAFE_INTEGER, { token: t })).body.filter(m => m.kind === 'result').length, 0);
    }
    assert.ok(!fs.existsSync(path.join(root, 'state', 'living-room')) || !fs.readdirSync(path.join(root, 'state', 'living-room')).some(f => fs.readFileSync(path.join(root, 'state', 'living-room', f), 'utf8').includes('"result"')), '归档文件里没有 result');
    // details 超 4 KiB 裁掉
    const big = await request(port, '/internal/gateway/results', { ...svc, method: 'POST', body: { ...result, request_id: 'req_0000000002', approval_id: second.body.approval_id, resident_id: 'resident_gamma_01', action: 'core.fs.read', status: 'denied', details: { blob: 'x'.repeat(6000) } } });
    assert.equal(big.status, 200, JSON.stringify(big.body));
    const gammaInbox = (await request(port, '/inbox', { token: gamma })).body.find(m => m.kind === 'result');
    assert.equal(gammaInbox.meta.details.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(gammaInbox.meta.details)) <= 4096 + 100);
    // 库里：一个 request 一条结果记录；approval 标 used
    assert.equal(room.db.prepare('SELECT COUNT(*) AS n FROM gateway_results').get().n, 2);
    assert.equal(room.db.prepare('SELECT used FROM approvals WHERE id=?').get(ok.body.approval_id).used, 1);
  } finally {
    await room.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('内部接口拒非 loopback 连接（用本机非回环地址模拟；没有就跳过）', async t => {
  const external = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal);
  if (!external) { t.skip('本机没有非回环 IPv4，无法模拟'); return; }
  const root = fixture();
  const tokenFile = path.join(root, 'run', 'gateway-service.token');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, SERVICE_TOKEN, { mode: 0o600 });
  const room = createLivingRoom({ houseDir: root, runDir: path.join(root, 'run'), dataDir: path.join(root, 'state'), port: 0, host: '0.0.0.0', gatewayServiceTokenFile: tokenFile });
  try {
    const port = (await room.listen()).port;
    const viaExternal = await request(port, '/internal/gateway/approval-results', { hostname: external.address, token: SERVICE_TOKEN });
    assert.equal(viaExternal.status, 403);
    assert.equal(viaExternal.body.error.code, 'GW-NOT-LOOPBACK');
    assert.equal((await request(port, '/internal/gateway/approval-results', { hostname: '127.0.0.1', token: SERVICE_TOKEN })).status, 200);
  } finally {
    await room.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// RFC 2026-09-15-gateway-allow §2.4 — policy_allow result contract (matrix 9, 10, 13)
test('政策放行结果：无 approval_id 也投递；policy_digest 存不比较；request_id 幂等；无效形状拒；人批路径不变', async () => {
  const root = fixture();
  const tokenFile = path.join(root, 'run', 'gateway-service.token');
  const room = createLivingRoom({ houseDir: root, runDir: path.join(root, 'run'), dataDir: path.join(root, 'state'), port: 0, approvalLimit: 50, gatewayServiceTokenFile: tokenFile });
  try {
    const port = (await room.listen()).port;
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true }); fs.writeFileSync(tokenFile, SERVICE_TOKEN + '\n', { mode: 0o600 });
    const beta = room.tokenStore.issue('resident_beta_01').token;
    const alpha = room.tokenStore.issue('resident_alpha_01').token;
    const svc = { token: SERVICE_TOKEN };
    const base = { request_id: 'req_policy0001', resident_id: 'resident_beta_01', action: 'core.exec.ro', run_id: 'sub_zz9999', status: 'succeeded', summary: 'grep done', coverage: { executor: 'bwrap', sandbox: 'enforced', network: 'denied', requested: ['exec:grep'], completed: ['exec:grep'] }, next: { kind: 'none' }, details: { exit_code: 0, stdout: '[output omitted]' } };

    // #9: policy result whose digest ≠ anything the living room knows → still delivered, digest stored
    const r1 = await request(port, '/internal/gateway/results', { ...svc, method: 'POST', body: { ...base, approval_id: null, decision: { source: 'policy_allow', policy_digest: 'deadbeef00000000' } } });
    assert.equal(r1.status, 200, JSON.stringify(r1.body)); assert.equal(r1.body.delivered_to, 'resident_beta_01'); assert.equal(r1.body.duplicate, false);
    const inbox = (await request(port, '/inbox', { token: beta })).body;
    const dm = inbox.find(m => m.kind === 'result' && m.meta && m.meta.request_id === 'req_policy0001');
    assert.ok(dm, 'result DM reached the resident');
    assert.equal(dm.meta.decision.source, 'policy_allow'); assert.equal(dm.meta.decision.policy_digest, 'deadbeef00000000'); assert.equal(dm.meta.approval_id, null); assert.equal(dm.meta.run_id, 'sub_zz9999');
    // not visible to another resident
    assert.ok(!(await request(port, '/inbox', { token: alpha })).body.some(m => m.meta && m.meta.request_id === 'req_policy0001'));

    // #10: same request_id again → duplicate, no second DM
    const r2 = await request(port, '/internal/gateway/results', { ...svc, method: 'POST', body: { ...base, approval_id: null, decision: { source: 'policy_allow', policy_digest: 'deadbeef00000000' } } });
    assert.equal(r2.status, 200); assert.equal(r2.body.duplicate, true);
    assert.equal((await request(port, '/inbox', { token: beta })).body.filter(m => m.meta && m.meta.request_id === 'req_policy0001').length, 1);

    // shape rejections
    assert.equal((await request(port, '/internal/gateway/results', { ...svc, method: 'POST', body: { ...base, request_id: 'req_policy0002', approval_id: 'apr_12345678', decision: { source: 'policy_allow', policy_digest: 'x' } } })).body.error.code, 'GW-RESULT-INVALID', 'policy + approval_id is contradictory');
    assert.equal((await request(port, '/internal/gateway/results', { ...svc, method: 'POST', body: { ...base, request_id: 'req_policy0003', approval_id: null, decision: { source: 'policy_allow' } } })).body.error.code, 'GW-RESULT-INVALID', 'missing policy_digest');
    assert.equal((await request(port, '/internal/gateway/results', { ...svc, method: 'POST', body: { ...base, request_id: 'req_policy0004', approval_id: null, resident_id: 'resident_nobody_01', decision: { source: 'policy_allow', policy_digest: 'x' } } })).status, 404, 'unknown resident');
    // human-path shape without approval → still the old 400 (regression)
    assert.equal((await request(port, '/internal/gateway/results', { ...svc, method: 'POST', body: { ...base, request_id: 'req_policy0005' } })).body.error.code, 'GW-RESULT-INVALID', 'no decision + no approval_id = old validation');
  } finally { await room.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
