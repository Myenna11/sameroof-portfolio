'use strict';
// 假网关（测试用）：docs/GATEWAY.md §2.1 的最小子集 + §3.2/§3.3 的消费端。零依赖，node http 听 Unix socket。
// 只登记 intent、拉客厅的权威决定流、把"结果"投回客厅——**不真执行任何动作**（coverage.executor = 'mock'）。
// G1 真网关上线后，seam-walk 测试换真网关只改 socket 路径；这里的形状就是适配器和客厅两边约定好的合同。
const http = require('http');
const crypto = require('crypto');
const jcs = require('@sameroof/jcs');

const ACTION_RE = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const REQUEST_ID_RE = /^req_[A-Za-z0-9_-]{6,80}$/;
const INTENT_FIELDS = new Set(['request_id', 'resident_id', 'run_id', 'action', 'params', 'requested_ttl_seconds']);
const BODY_MAX = 256 * 1024;

const reply = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const fail = (res, status, code, message) => reply(res, status, { error: { code, message } });
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// 客厅内部接口：loopback + Bearer service token
function lrRequest(base, method, pathname, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, base);
    const buf = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: {
      authorization: 'Bearer ' + token, ...(buf ? { 'content-type': 'application/json', 'content-length': buf.length } : {})
    } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let value = text; try { value = JSON.parse(text); } catch {} resolve({ status: res.statusCode, body: value }); });
    });
    req.on('error', reject); if (buf) req.write(buf); req.end();
  });
}

// start({ socketPath, tokens: { resident_id: token }, ttlDefault? }) → Promise<{ pump, intents, results, close, socketPath }>
async function start({ socketPath, tokens = {}, ttlDefault = 1800 } = {}) {
  if (!socketPath) throw new TypeError('mock-gateway 要 socketPath');
  const intents = new Map();                 // request_id → { request_id, resident_id, run_id, action, params, params_digest, state, payload, response, result }
  const results = [];                        // 投回客厅的每一条
  let cursor = 0;                            // 决定流游标（内存里；真网关要落事务库）
  let closed = false;

  const subjectOf = req => { const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || '')); if (!m) return null; return Object.keys(tokens).find(id => tokens[id] === m[1]) || null; };

  function postIntent(req, res, raw) {
    const subject = subjectOf(req);
    if (!subject) return fail(res, 401, 'GW-AUTH-INVALID', '没有或不认识这个 adapter token。');
    let body;
    try { body = jcs.parseStrict(raw); } catch (e) { return fail(res, 400, 'GW-BODY-INVALID', '请求体不是严格 JSON：' + e.message); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'GW-BODY-INVALID', '请求体得是对象。');
    for (const k of Object.keys(body)) if (!INTENT_FIELDS.has(k)) return fail(res, 400, 'GW-UNKNOWN-FIELD', '不认识的字段：' + k);
    if (typeof body.request_id !== 'string' || !REQUEST_ID_RE.test(body.request_id)) return fail(res, 400, 'GW-REQUEST-ID-INVALID', 'request_id 不合法。');
    if (req.headers['idempotency-key'] !== body.request_id) return fail(res, 400, 'GW-IDEMPOTENCY-KEY', 'Idempotency-Key 必须等于 request_id。');
    if (body.resident_id !== subject) return fail(res, 403, 'GW-SUBJECT-MISMATCH', 'token subject 与 resident_id 不一致。');
    if (typeof body.action !== 'string' || body.action.length > 160 || !ACTION_RE.test(body.action)) return fail(res, 400, 'GW-ACTION-INVALID', 'action 不合法。');
    if (!body.params || typeof body.params !== 'object' || Array.isArray(body.params)) return fail(res, 400, 'GW-PARAMS-INVALID', 'params 得是对象。');
    if (body.run_id !== undefined && body.run_id !== null && typeof body.run_id !== 'string') return fail(res, 400, 'GW-RUN-ID-INVALID', 'run_id 得是字符串。');
    const ttl = body.requested_ttl_seconds === undefined ? ttlDefault : body.requested_ttl_seconds;
    if (!Number.isInteger(ttl) || ttl < 30 || ttl > 3600) return fail(res, 400, 'GW-TTL-INVALID', 'requested_ttl_seconds 得在 30..3600。');
    let payload, paramsDigest;
    try { payload = jcs.canonicalize(body); paramsDigest = jcs.digest(body.params); } catch (e) { return fail(res, 400, 'GW-PARAMS-INVALID', 'params 不能规范化：' + e.message); }
    const existing = intents.get(body.request_id);
    if (existing) return existing.payload === payload ? reply(res, 200, existing.response) : fail(res, 409, 'GW-IDEMPOTENCY-CONFLICT', '同 request_id 但 payload 不同。');
    const p = body.params;
    const targetDigest = sha256(jcs.canonicalize({ action: body.action, root_id: p.root_id === undefined ? null : p.root_id, path: p.path === undefined ? null : p.path, cwd: p.cwd === undefined ? null : p.cwd }));
    const response = {
      request_id: body.request_id, state: 'awaiting_approval', action: body.action, params_digest: paramsDigest, target_digest: targetDigest,
      expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
      approval_body: { action: body.action, params: p, params_digest: paramsDigest, gateway_request_id: body.request_id, ttl_seconds: ttl }
    };
    intents.set(body.request_id, { request_id: body.request_id, resident_id: body.resident_id, run_id: body.run_id || null, action: body.action, params: p, params_digest: paramsDigest,
      ttl, state: 'awaiting_approval', received_at: new Date().toISOString(), payload, response, result: null });
    return reply(res, 201, response);
  }
  function getIntent(req, res, id) {
    const subject = subjectOf(req);
    if (!subject) return fail(res, 401, 'GW-AUTH-INVALID', '没有或不认识这个 adapter token。');
    const rec = intents.get(id);
    if (!rec || rec.resident_id !== subject) return fail(res, 404, 'GW-INTENT-NOT-FOUND', '没有这个 intent。');   // 别人的也说没有，不泄露存在性
    return reply(res, 200, { request_id: rec.request_id, state: rec.state, action: rec.action, params_digest: rec.params_digest, expires_at: rec.response.expires_at, result: rec.result && { status: rec.result.status, summary: rec.result.summary } });
  }

  const server = http.createServer((req, res) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size <= BODY_MAX) chunks.push(c); });
    req.on('end', () => {
      if (size > BODY_MAX) return fail(res, 413, 'GW-BODY-TOO-LARGE', 'body 超 256 KiB。');
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const url = new URL(req.url, 'http://gateway.local');
        if (req.method === 'POST' && url.pathname === '/v1/intents') return postIntent(req, res, raw);
        const m = /^\/v1\/intents\/([^/]+)$/.exec(url.pathname);
        if (req.method === 'GET' && m) return getIntent(req, res, m[1]);
        return fail(res, 404, 'GW-ROUTE-NOT-FOUND', '没这个门。');
      } catch (e) { return fail(res, 500, 'GW-INTERNAL', e.message); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });

  // 消费客厅的权威决定流（§3.2），对自己登记过的 intent 投回结果（§3.3）。allowed → 假装执行成功；denied → denied；绑定字段不一致 → failed。
  async function pump(livingRoomBase, serviceToken) {
    const page = await lrRequest(livingRoomBase, 'GET', `/internal/gateway/approval-results?after_seq=${cursor}&limit=100`, serviceToken);
    if (page.status !== 200) throw new Error(`拉决定流失败 ${page.status}: ${JSON.stringify(page.body).slice(0, 200)}`);
    const delivered = [], skipped = [];
    for (const item of page.body.items) {
      cursor = Math.max(cursor, item.seq);
      const rec = intents.get(item.gateway_request_id);
      if (!rec) { skipped.push({ seq: item.seq, gateway_request_id: item.gateway_request_id, why: 'not-mine' }); continue; }
      if (rec.state !== 'awaiting_approval') { skipped.push({ seq: item.seq, gateway_request_id: item.gateway_request_id, why: 'already-' + rec.state }); continue; }
      const bound = rec.resident_id === item.resident_id && rec.action === item.action && rec.params_digest === item.params_digest && item.single_use === true
        && item.expires_at && Date.parse(item.expires_at) > Date.now() && Date.parse(rec.response.expires_at) > Date.now();
      let status, summary;
      if (item.decision === 'allowed' && bound) { status = 'succeeded'; summary = '（假网关）已执行 ' + rec.action; }
      else if (item.decision === 'denied') { status = 'denied'; summary = '（假网关）人拒绝了 ' + rec.action + '，没执行'; }
      else { status = 'failed'; summary = '（假网关）决定的绑定字段与 intent 不一致或已过期，没执行'; }
      rec.state = status;
      const result = {
        request_id: rec.request_id, approval_id: item.approval_id, resident_id: rec.resident_id, action: rec.action, status,
        coverage: { executor: 'mock', network: 'denied', requested: [], completed: [] }, next: { kind: 'none' }, summary, details: { mock: true, decided_by: item.decided_by }
      };
      const r = await lrRequest(livingRoomBase, 'POST', '/internal/gateway/results', serviceToken, result);
      rec.result = { ...result, http: r.status, response: r.body };
      results.push(rec.result); delivered.push(rec.result);
    }
    return { next_seq: cursor, delivered, skipped };
  }
  async function close() { if (closed) return; closed = true; await new Promise(r => server.close(r)); }   // server.close 会顺手删掉 socket 文件
  return { pump, intents, results, close, socketPath, get cursor() { return cursor; } };
}
module.exports = { start };
