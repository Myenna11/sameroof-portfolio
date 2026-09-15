// 同屋 · 适配器 → 能力网关客户端（docs/GATEWAY.md §2）。
// 只做两件事：把住户回的 APPROVAL: 行解析成 { action, params }；把 intent 登记到 gateway.sock 拿 approval_body。
// 不执行任何动作。网关 socket 不在、超时、非 2xx、token 文件缺 → 抛 GatewayUnavailable（fail closed，调用方不得绕过网关直接发审批）。
'use strict';
const fs = require('fs'), http = require('http'), crypto = require('crypto');
const jcs = require('@sameroof/jcs');

const DEFAULT_SOCK = '/run/sameroof-gateway/gateway.sock';
const DEFAULT_TOKEN_DIR = '/run/sameroof-gateway/tokens';
const RESPONSE_MAX = 256 * 1024;
const ACTION_RE = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;

class GatewayUnavailable extends Error {
  constructor(message, extra = {}) { super(message); this.name = 'GatewayUnavailable'; this.code = extra.code || 'GATEWAY-UNAVAILABLE'; this.status = extra.status || null; }
}

const socketPath = () => process.env.SAMEROOF_GATEWAY_SOCK || DEFAULT_SOCK;
const tokenFile = residentId => process.env.SAMEROOF_GATEWAY_TOKEN_FILE || `${DEFAULT_TOKEN_DIR}/${residentId}`;
const newRequestId = () => 'req_' + Date.now().toString(36) + crypto.randomBytes(8).toString('hex');

function readToken(residentId) {
  const file = tokenFile(residentId);
  let token;
  try { token = fs.readFileSync(file, 'utf8').trim(); }
  catch (e) { throw new GatewayUnavailable(`网关 adapter token 读不到（${file}）：${e.code || e.message}`, { code: 'GATEWAY-TOKEN-MISSING' }); }
  if (!token) throw new GatewayUnavailable(`网关 adapter token 是空的（${file}）`, { code: 'GATEWAY-TOKEN-MISSING' });
  return token;
}

// APPROVAL: <action> <JSON 参数>。JSON 用 parseStrict（重复键即拒）；容忍全角冒号和 ```json 围栏，其它一概不猜。
function parseApprovalLine(text) {
  const m = /^\s*APPROVAL[:：]\s*(\S+)\s*([\s\S]*)$/.exec(String(text || ''));
  if (!m) throw new Error('不是 APPROVAL: 行');
  const action = m[1];
  if (action.length > 160 || !ACTION_RE.test(action)) throw new Error('action 不合法：' + action.slice(0, 60));
  const json = m[2].trim().replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
  if (!json) throw new Error('缺 JSON 参数');
  let params;
  try { params = jcs.parseStrict(json); }
  catch (e) { throw new Error('参数不是严格 JSON：' + e.message); }
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('参数得是 JSON 对象');
  return { action, params };
}

// POST /v1/intents → { request_id, state, action, params_digest, target_digest, expires_at, approval_body }
async function registerIntent({ residentId, runId, action, params, ttl = 1800, requestId = newRequestId(), timeoutMs = 5000 } = {}) {   // async：token 缺、参数错也都是 reject，调用方只需一个 try/await
  if (typeof residentId !== 'string' || !residentId) throw new TypeError('registerIntent 要 residentId');
  if (typeof action !== 'string' || !ACTION_RE.test(action)) throw new TypeError('registerIntent 的 action 不合法');
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new TypeError('registerIntent 的 params 得是对象');
  const token = readToken(residentId);
  const body = Buffer.from(JSON.stringify({ request_id: requestId, resident_id: residentId, run_id: runId || null, action, params, requested_ttl_seconds: ttl }));
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (message, extra) => { if (settled) return; settled = true; reject(new GatewayUnavailable(message, extra)); };
    const req = http.request({
      socketPath: socketPath(), path: '/v1/intents', method: 'POST', timeout: timeoutMs,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': body.length, 'idempotency-key': requestId }
    }, res => {
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size <= RESPONSE_MAX) chunks.push(c); });
      res.on('error', e => fail('网关响应读取失败：' + e.message, { code: 'GATEWAY-BAD-RESPONSE' }));
      res.on('end', () => {
        if (settled) return;
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(text); } catch {}
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const code = (parsed && parsed.error && parsed.error.code) || 'GATEWAY-HTTP-' + res.statusCode;
          return fail(`网关拒了登记（${res.statusCode} ${code}）：${((parsed && parsed.error && parsed.error.message) || text).slice(0, 200)}`, { code, status: res.statusCode });
        }
        if (!parsed || !parsed.approval_body || typeof parsed.approval_body !== 'object') return fail('网关响应缺 approval_body', { code: 'GATEWAY-BAD-RESPONSE', status: res.statusCode });
        if (parsed.approval_body.gateway_request_id !== requestId) return fail('网关回的 approval_body.gateway_request_id 与登记的 request_id 不一致', { code: 'GATEWAY-BAD-RESPONSE', status: res.statusCode });
        settled = true;
        resolve({ request_id: requestId, ...parsed });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); fail(`网关 ${timeoutMs}ms 没回应`, { code: 'GATEWAY-TIMEOUT' }); });
    req.on('error', e => fail(`连不上网关（${socketPath()}）：${e.code || e.message}`, { code: e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'GATEWAY-SOCKET-MISSING' : 'GATEWAY-UNAVAILABLE' }));
    req.end(body);
  });
}

// 网关此刻能不能用：socket 在、这位住户的 token 文件在。只用来决定提示里让不让住户写 APPROVAL，真正的 fail closed 在 registerIntent。
function available(residentId) { try { return fs.existsSync(socketPath()) && fs.existsSync(tokenFile(residentId)); } catch { return false; } }
// GET /v1/intents/:id (state) and GET /v1/intents/:id/output (RFC §2.3b). Both reject on transport failure; HTTP errors resolve with {status, error}.
function getJson(residentId, pathname, extraHeaders = {}, timeoutMs = 5000) {
  const token = readToken(residentId);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (message, extra) => { if (settled) return; settled = true; reject(new GatewayUnavailable(message, extra)); };
    const req = http.request({ socketPath: socketPath(), path: pathname, method: 'GET', timeout: timeoutMs, headers: { authorization: `Bearer ${token}`, ...extraHeaders } }, res => {
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size <= RESPONSE_MAX) chunks.push(c); });
      res.on('end', () => { if (settled) return; settled = true; let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
        if (res.statusCode >= 200 && res.statusCode < 300 && body) return resolve({ status: res.statusCode, body });
        resolve({ status: res.statusCode, error: (body && body.error) || { code: 'GW-HTTP-' + res.statusCode } }); });
    });
    req.on('timeout', () => { req.destroy(); fail('网关响应超时', { code: 'GATEWAY-TIMEOUT' }); });
    req.on('error', e => fail('网关不可达：' + e.message, { code: 'GATEWAY-UNAVAILABLE' }));
    req.end();
  });
}
function getIntent(residentId, requestId, opts = {}) { return getJson(residentId, '/v1/intents/' + encodeURIComponent(requestId), {}, opts.timeoutMs); }
function readOutput(residentId, requestId, runId, opts = {}) { return getJson(residentId, '/v1/intents/' + encodeURIComponent(requestId) + '/output', { 'x-sameroof-run': runId || '' }, opts.timeoutMs); }
module.exports = { registerIntent, getIntent, readOutput, parseApprovalLine, readToken, newRequestId, GatewayUnavailable, socketPath, tokenFile, available };
