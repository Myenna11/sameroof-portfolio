#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { BrokerStore, BrokerError } = require('./store');

const MAX_BODY = 2 * 1024 * 1024;
const MAX_RESPONSE = 20 * 1024 * 1024;

function json(res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, ...headers });
  res.end(body);
}

function errorResponse(res, error) {
  const status = error instanceof BrokerError ? error.status : 500;
  const code = error instanceof BrokerError ? error.code : 'BROKER-INTERNAL';
  if (!(error instanceof BrokerError)) console.error('[broker]', error);
  json(res, status, { error: { code, message: error.message || 'broker 内部错误' } });
}

function bearer(req) {
  const raw = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  if (!match) throw new BrokerError(401, 'TOKEN-INVALID', '缺少住户 bearer token。');
  return match[1];
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new BrokerError(413, 'REQUEST-TOO-LARGE', '请求体超过 2 MiB。'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new BrokerError(400, 'REQUEST-JSON-INVALID', '请求体不是合法 JSON。')); }
    });
    req.on('error', reject);
  });
}

function estimateReservation(body) {
  const input = Math.ceil(Buffer.byteLength(JSON.stringify(body.messages || []), 'utf8') / 4);
  const output = Number(body.max_completion_tokens || body.max_tokens || 4096);
  if (!Number.isSafeInteger(output) || output < 0) throw new BrokerError(400, 'MAX-TOKENS-INVALID', 'max_tokens 必须是非负整数。');
  return Math.max(1, input + Math.min(output, 200000));
}

async function readResponseLimited(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_RESPONSE) throw new BrokerError(502, 'UPSTREAM-RESPONSE-TOO-LARGE', '上游响应超过 20 MiB。');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE) { await reader.cancel(); throw new BrokerError(502, 'UPSTREAM-RESPONSE-TOO-LARGE', '上游响应超过 20 MiB。'); }
    chunks.push(Buffer.from(part.value));
  }
  return Buffer.concat(chunks, size);
}

function buildUpstreamUrl(baseUrl, requestPath, pathStyle = 'auto') {
  const upstream = new URL(baseUrl);
  const queryIndex = requestPath.indexOf('?');
  const pathname = queryIndex >= 0 ? requestPath.slice(0, queryIndex) : requestPath;
  const search = queryIndex >= 0 ? requestPath.slice(queryIndex) : '';
  let basePath = upstream.pathname.replace(/\/$/, '');
  let suffix = pathname;
  const stripV1 = pathStyle === 'bare' || (pathStyle === 'auto' && /\/v\d+$/.test(basePath));
  if (stripV1 && suffix.startsWith('/v1/')) suffix = suffix.slice(3);
  upstream.pathname = basePath + (suffix.startsWith('/') ? suffix : '/' + suffix);
  upstream.search = search;
  return upstream;
}

function safeUpstreamHeaders(req, credential) {
  const headers = { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'sameroof-broker/0.1' };
  if (req.headers['openai-organization']) headers['openai-organization'] = String(req.headers['openai-organization']);
  const value = credential.auth_scheme ? credential.auth_scheme + ' ' + credential.api_key : credential.api_key;
  headers[credential.auth_header] = value;
  return headers;
}

function createBroker(options = {}) {
  const store = options.store || new BrokerStore({ home: options.home, dbPath: options.dbPath });
  const ownsStore = !options.store;
  const socketPath = path.resolve(options.socketPath || process.env.SAMEROOF_BROKER_SOCKET || path.join(store.runDir, 'broker.sock'));
  const bindPath = path.join(path.dirname(socketPath), '.' + path.basename(socketPath) + '.' + process.pid + '.' + require('crypto').randomBytes(6).toString('hex'));
  let socketIdentity = null;

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });

      const secret = bearer(req);
      if (req.method === 'GET' && req.url.split('?')[0] === '/v1/models') {
        const token = store.authenticate(secret);
        const data = token.models.filter(model => model !== '*').map(model => ({ id: model, object: 'model', owned_by: 'sameroof-allowlist' }));
        return json(res, 200, { object: 'list', data });
      }

      if (req.method !== 'POST' || req.url.split('?')[0] !== '/v1/chat/completions') {
        throw new BrokerError(404, 'BROKER-ROUTE-NOT-FOUND', '第一版只开放 /v1/models 与 /v1/chat/completions。');
      }

      const body = await readJson(req);
      if (!body.model) throw new BrokerError(400, 'MODEL-REQUIRED', 'chat/completions 必须写 model。');
      if (body.stream === true) throw new BrokerError(400, 'STREAM-NOT-YET-SUPPORTED', '第一版 broker 暂不转发 stream=true，请使用非流式请求。');

      const purpose = String(req.headers['x-sameroof-purpose'] || 'interactive');
      const credentialAlias = req.headers['x-sameroof-credential'] ? String(req.headers['x-sameroof-credential']) : null;
      const reservation = store.reserve(secret, {
        credential: credentialAlias,
        purpose,
        model: String(body.model),
        reserveTokens: estimateReservation(body)
      });

      let upstreamResponse;
      try {
        upstreamResponse = await fetch(buildUpstreamUrl(reservation.credential.base_url, req.url, reservation.credential.path_style), {
          method: 'POST',
          headers: safeUpstreamHeaders(req, reservation.credential),
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(Number(options.timeoutMs || 120000))
        });
      } catch (error) {
        store.settle(reservation.requestId, { status: 'network_error', httpStatus: 502, latencyMs: Date.now() - started });
        throw new BrokerError(502, 'UPSTREAM-UNREACHABLE', '上游连接失败：' + error.message);
      }

      let responseBuffer;
      try { responseBuffer = await readResponseLimited(upstreamResponse); }
      catch (error) {
        store.settle(reservation.requestId, { status: 'response_rejected', httpStatus: 502, latencyMs: Date.now() - started });
        throw error;
      }
      const contentType = upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8';
      let usage = null;
      try {
        const parsed = JSON.parse(responseBuffer.toString('utf8'));
        usage = parsed.usage || null;
      } catch {}
      const actualTokens = usage && Number.isFinite(Number(usage.total_tokens)) ? Number(usage.total_tokens) : null;
      store.settle(reservation.requestId, {
        actualTokens,
        estimated: actualTokens == null,
        status: upstreamResponse.ok ? 'complete' : 'upstream_error',
        httpStatus: upstreamResponse.status,
        latencyMs: Date.now() - started
      });
      res.writeHead(upstreamResponse.status, {
        'content-type': contentType,
        'content-length': responseBuffer.length,
        'x-sameroof-request-id': reservation.requestId
      });
      res.end(responseBuffer);
    } catch (error) {
      if (!res.headersSent) errorResponse(res, error);
      else res.destroy();
    }
  });

  function prepareSocket() {
    if (!socketPath.startsWith(store.runDir + path.sep)) throw new Error('broker socket 必须放在 ' + store.runDir + ' 里面。');
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    if (fs.existsSync(socketPath) && !fs.lstatSync(socketPath).isSocket()) throw new Error('拒绝覆盖非 socket 路径：' + socketPath);
    if (fs.existsSync(bindPath)) throw new Error('私有 bind 路径已存在：' + bindPath);
  }

  function listen() {
    prepareSocket();
    return new Promise((resolve, reject) => {
      const onError = error => {
        server.off('listening', onListening);
        try { if (fs.existsSync(bindPath) && fs.lstatSync(bindPath).isSocket()) fs.unlinkSync(bindPath); } catch {}
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        try {
          if (fs.existsSync(socketPath)) {
            if (!fs.lstatSync(socketPath).isSocket()) throw new Error('拒绝覆盖非 socket 路径：' + socketPath);
            fs.unlinkSync(socketPath);
          }
          fs.renameSync(bindPath, socketPath);
          fs.chmodSync(socketPath, 0o600);
          const stat = fs.lstatSync(socketPath);
          socketIdentity = { dev: stat.dev, ino: stat.ino, ctimeMs: stat.ctimeMs };
          resolve({ socketPath });
        } catch (error) {
          server.close(() => {});
          reject(error);
        }
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(bindPath);
    });
  }

  function close() {
    return new Promise(resolve => {
      server.close(() => {
        try {
          if (fs.existsSync(socketPath) && socketIdentity) {
            const stat = fs.lstatSync(socketPath);
            const mine = stat.isSocket() && stat.dev === socketIdentity.dev && stat.ino === socketIdentity.ino && stat.ctimeMs === socketIdentity.ctimeMs;
            if (mine) fs.unlinkSync(socketPath);
          }
        } catch {}
        if (ownsStore) store.close();
        resolve();
      });
    });
  }

  return { server, store, socketPath, listen, close };
}

async function main() {
  const broker = createBroker();
  const result = await broker.listen();
  console.log('同屋·凭证 broker 已监听 ' + result.socketPath);
  const stop = async () => { await broker.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main().catch(error => { console.error(error); process.exit(1); });

module.exports = { createBroker, buildUpstreamUrl, estimateReservation };
