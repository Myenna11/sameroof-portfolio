'use strict';
// 适配器 → 网关客户端：临时 Unix socket 假网关；APPROVAL: 行解析；收件箱 result 渲染。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const jcs = require('@sameroof/jcs');
const gw = require('../lib/gateway-client');
const { renderInboxLine, parseApprovalLine } = require('../lib/room');

const params = { root_id: 'own-room', path: 'notes/today.md', content: 'hi\n', mode: 'replace' };

function fakeGateway(handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-gw-'));
  const sock = path.join(dir, 'gateway.sock');
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, 'adapter-token-' + 'x'.repeat(40) + '\n', { mode: 0o600 });
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      handler(req, res, seen[seen.length - 1]);
    });
  });
  return {
    seen, sock, tokenFile, dir,
    async start() { await new Promise(r => server.listen(sock, r)); process.env.SAMEROOF_GATEWAY_SOCK = sock; process.env.SAMEROOF_GATEWAY_TOKEN_FILE = tokenFile; },
    async stop() { await new Promise(r => server.close(r)); delete process.env.SAMEROOF_GATEWAY_SOCK; delete process.env.SAMEROOF_GATEWAY_TOKEN_FILE; fs.rmSync(dir, { recursive: true, force: true }); }
  };
}
const reply = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };

test('registerIntent：走 Unix socket，带 Bearer token 与 Idempotency-Key，原样拿回 approval_body', async () => {
  const g = fakeGateway((req, res, r) => reply(res, 201, {
    request_id: r.body.request_id, state: 'awaiting_approval', action: r.body.action, params_digest: jcs.digest(r.body.params), target_digest: 'e'.repeat(64), expires_at: '2026-09-07T12:34:56.000Z',
    approval_body: { action: r.body.action, params: r.body.params, params_digest: jcs.digest(r.body.params), gateway_request_id: r.body.request_id, ttl_seconds: r.body.requested_ttl_seconds }
  }));
  await g.start();
  try {
    const out = await gw.registerIntent({ residentId: 'resident_beta_01', runId: 'run_abc', action: 'core.fs.write', params, ttl: 600 });
    assert.match(out.request_id, /^req_[a-z0-9]{6,}$/);
    assert.equal(out.state, 'awaiting_approval');
    assert.equal(out.approval_body.gateway_request_id, out.request_id);
    assert.equal(out.approval_body.params_digest, jcs.digest(params));
    assert.deepEqual(out.approval_body.params, params);
    assert.equal(out.approval_body.ttl_seconds, 600);
    assert.equal(g.seen.length, 1);
    assert.equal(g.seen[0].method, 'POST');
    assert.equal(g.seen[0].url, '/v1/intents');
    assert.equal(g.seen[0].headers.authorization, 'Bearer adapter-token-' + 'x'.repeat(40));
    assert.equal(g.seen[0].headers['idempotency-key'], out.request_id);
    assert.deepEqual(g.seen[0].body, { request_id: out.request_id, resident_id: 'resident_beta_01', run_id: 'run_abc', action: 'core.fs.write', params, requested_ttl_seconds: 600 });
  } finally { await g.stop(); }
});

test('registerIntent：socket 不存在 → GatewayUnavailable（fail closed）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-gw-'));
  fs.writeFileSync(path.join(dir, 'token'), 'adapter-token-' + 'x'.repeat(40));
  process.env.SAMEROOF_GATEWAY_SOCK = path.join(dir, 'nope.sock');
  process.env.SAMEROOF_GATEWAY_TOKEN_FILE = path.join(dir, 'token');
  try {
    await assert.rejects(gw.registerIntent({ residentId: 'r', runId: 'x', action: 'core.fs.read', params: { root_id: 'own-room', path: 'a' } }), e => e instanceof gw.GatewayUnavailable && e.code === 'GATEWAY-SOCKET-MISSING');
  } finally { delete process.env.SAMEROOF_GATEWAY_SOCK; delete process.env.SAMEROOF_GATEWAY_TOKEN_FILE; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('registerIntent：非 2xx / 响应缺 approval_body / request_id 不一致 / 超时 都抛 GatewayUnavailable', async () => {
  let mode = 'deny';
  const g = fakeGateway((req, res, r) => {
    if (mode === 'deny') return reply(res, 403, { error: { code: 'GW-AUTH-DENIED', message: 'token subject 不对' } });
    if (mode === 'empty') return reply(res, 200, { state: 'awaiting_approval' });
    if (mode === 'swap') return reply(res, 200, { approval_body: { gateway_request_id: 'req_someoneelse', action: r.body.action, params: r.body.params } });
    if (mode === 'hang') return;                                              // 不回
  });
  await g.start();
  try {
    const call = extra => gw.registerIntent({ residentId: 'r', runId: 'x', action: 'core.exec', params: { argv: ['ls'] }, ...extra });
    await assert.rejects(call(), e => e instanceof gw.GatewayUnavailable && e.code === 'GW-AUTH-DENIED' && e.status === 403);
    mode = 'empty';
    await assert.rejects(call(), e => e instanceof gw.GatewayUnavailable && e.code === 'GATEWAY-BAD-RESPONSE');
    mode = 'swap';
    await assert.rejects(call(), e => e instanceof gw.GatewayUnavailable && e.code === 'GATEWAY-BAD-RESPONSE');
    mode = 'hang';
    await assert.rejects(call({ timeoutMs: 150 }), e => e instanceof gw.GatewayUnavailable && e.code === 'GATEWAY-TIMEOUT');
  } finally { await g.stop(); }
});

test('registerIntent：token 文件缺 → GatewayUnavailable，且根本不连网关', async () => {
  const g = fakeGateway((req, res) => reply(res, 200, {}));
  await g.start();
  try {
    fs.rmSync(g.tokenFile);
    await assert.rejects(gw.registerIntent({ residentId: 'r', runId: 'x', action: 'core.fs.read', params: { root_id: 'own-room', path: 'a' } }), e => e instanceof gw.GatewayUnavailable && e.code === 'GATEWAY-TOKEN-MISSING');
    assert.equal(g.seen.length, 0);
    delete process.env.SAMEROOF_GATEWAY_TOKEN_FILE;
    assert.equal(gw.tokenFile('resident_x'), '/run/sameroof-gateway/tokens/resident_x');
    assert.equal(gw.socketPath(), g.sock);
  } finally { await g.stop(); }
});

test('parseApprovalLine：APPROVAL: <action> <JSON>；多行 JSON、围栏、全角冒号可以；格式错都抛', () => {
  assert.deepEqual(parseApprovalLine('APPROVAL: core.fs.write {"root_id":"own-room","path":"notes/today.md","content":"x","mode":"replace"}'),
    { action: 'core.fs.write', params: { root_id: 'own-room', path: 'notes/today.md', content: 'x', mode: 'replace' } });
  assert.deepEqual(parseApprovalLine('APPROVAL: core.exec\n{\n  "argv": ["npm", "test"],\n  "cwd": {"root_id": "project-sameroof", "path": ""}\n}\n'),
    { action: 'core.exec', params: { argv: ['npm', 'test'], cwd: { root_id: 'project-sameroof', path: '' } } });
  assert.deepEqual(parseApprovalLine('APPROVAL：core.fs.read ```json\n{"root_id":"own-room","path":"a.md"}\n```'), { action: 'core.fs.read', params: { root_id: 'own-room', path: 'a.md' } });
  assert.equal(gw.parseApprovalLine, parseApprovalLine);
  assert.throws(() => parseApprovalLine('APPROVAL: core.fs.write'), /缺 JSON/);
  assert.throws(() => parseApprovalLine('APPROVAL: core.fs.write path=notes/today.md'), /严格 JSON/);
  assert.throws(() => parseApprovalLine('APPROVAL: core.fs.write {"a":1,"a":2}'), /重复/);
  assert.throws(() => parseApprovalLine('APPROVAL: core.fs.write [1,2]'), /对象/);
  assert.throws(() => parseApprovalLine('APPROVAL: core.fs.write {"a":1} 再说一句'), /严格 JSON/);
  assert.throws(() => parseApprovalLine('APPROVAL: rm-rf {"a":1}'), /action 不合法/);
  assert.throws(() => parseApprovalLine('APPROVAL: Core.FS.Write {"a":1}'), /action 不合法/);
  assert.throws(() => parseApprovalLine('我想 APPROVAL: core.fs.write {"a":1}'), /不是 APPROVAL/);
  assert.throws(() => parseApprovalLine(''), /不是 APPROVAL/);
});

test('renderInboxLine：result 类显示 [网关结果 <status>]，next 非 none 附一句；普通消息不变', () => {
  const base = { ts: '2026-09-07T10:05:00.000Z', from: '房子', from_id: 'house', to_id: 'me', kind: 'result', text: '已写入 notes/today.md', mentions: ['me'] };
  assert.equal(renderInboxLine({ ...base, meta: { status: 'succeeded', next: { kind: 'none' } } }, 'me'), '[10:05] [网关结果 succeeded] 已写入 notes/today.md');
  assert.equal(renderInboxLine({ ...base, text: '写不了', meta: { status: 'failed', next: { kind: 'request_writable_root', root_id: 'project-sameroof', path: 'docs' } } }, 'me'), '[10:05] [网关结果 failed] 写不了（下一步建议：request_writable_root docs）');
  assert.equal(renderInboxLine({ ...base, meta: { status: 'denied', next: { kind: 'human_action' } } }, 'me'), '[10:05] [网关结果 denied] 已写入 notes/today.md（下一步建议：human_action）');
  assert.equal(renderInboxLine({ ...base, meta: null }, 'me'), '[10:05] [网关结果 ?] 已写入 notes/today.md');
  assert.equal(renderInboxLine({ ts: '2026-09-07T10:05:00.000Z', from: '甲', kind: 'dm', text: '在吗', mentions: ['me'] }, 'me'), '[10:05] 甲(私信给你)(叫了你)：在吗');
  assert.equal(renderInboxLine({ ts: '2026-09-07T10:05:00.000Z', from: '甲', kind: 'say', text: '大家好', mentions: [] }, 'me'), '[10:05] 甲：大家好');
});
