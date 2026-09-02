#!/usr/bin/env node
// 同屋 · 客厅 — 公网入口只搬文字，不执行工具。
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const Database = require('better-sqlite3');
const { TokenStore } = require('./tokens');
const { SlidingWindowLimiter, AuthFailureLimiter } = require('./rate-limit');
const { PushClient, PushClientError } = require('./push-client');

const RESERVED = new Set(['system', 'all', 'everyone', 'house']);
const MESSAGE_MAX = 8000;
const BODY_MAX = 64 * 1024;
const ACK_MAX = 200;
const SSE_TOTAL_MAX = 100;
const SSE_RESIDENT_MAX = 3;
const SSE_IP_MAX = 10;
const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const norm = value => String(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

function securityHeaders(api = true) {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://house.sameroof.example; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    ...(api ? { 'cache-control': 'no-store' } : {})
  };
}

function writeJson(res, status, value, extra = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { ...securityHeaders(true), 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, ...extra });
  res.end(body);
}

function connectionIdentity(req, trustLoopbackProxy = true) {
  const remote = String(req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
  const loopback = remote === '127.0.0.1' || remote === '::1';
  if (trustLoopbackProxy && loopback) {
    const cloudflare = String(req.headers['cf-connecting-ip'] || '').trim();
    if (net.isIP(cloudflare)) return { ip: cloudflare, authFailureKey: cloudflare };
  }
  return { ip: remote, authFailureKey: loopback ? null : remote };
}

function clientIp(req, trustLoopbackProxy = true) {
  return connectionIdentity(req, trustLoopbackProxy).ip;
}

function readJson(req, maxBytes = BODY_MAX) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      reject(new HttpError(413, 'BODY-TOO-LARGE', '请求体超过 64 KiB。'));
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new HttpError(413, 'BODY-TOO-LARGE', '请求体超过 64 KiB。'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new HttpError(400, 'JSON-INVALID', '请求体不是合法 JSON。')); }
    });
    req.on('error', reject);
  });
}

function loadResidents(houseDir) {
  const dir = path.join(houseDir, 'rooms');
  const list = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, 'room.yaml');
    if (!fs.existsSync(file)) continue;
    const resident = yaml.load(fs.readFileSync(file, 'utf8'));
    if (!resident || !resident.id || !resident.name) throw new Error(file + ': 缺 id 或 name');
    resident.species = resident.species || 'agent';
    resident._names = [resident.name, ...(resident.aliases || [])].map(norm);
    resident._dir = path.join(dir, entry.name);
    list.push(resident);
  }
  const names = [];
  for (const resident of list) for (const name of resident._names) {
    if (RESERVED.has(name)) throw new Error(resident.name + ': “' + name + '”是保留名');
    for (const previous of names) {
      if (name === previous.name || name.startsWith(previous.name) || previous.name.startsWith(name)) {
        throw new Error('名字冲突：' + resident.name + ' 的“' + name + '”与 ' + previous.owner + ' 的“' + previous.name + '”相同或互为前缀');
      }
    }
    names.push({ name, owner: resident.name });
  }
  return list;
}

function textField(body, key, max = MESSAGE_MAX) {
  if (!body || typeof body[key] !== 'string' || !body[key].trim()) throw new HttpError(400, 'TEXT-REQUIRED', '要有 ' + key + '。');
  if (body[key].length > max) throw new HttpError(413, 'TEXT-TOO-LONG', key + ' 最长 ' + max + ' 个字符。');
  return body[key];
}

function positiveInt(value, fallback, min, max, code) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new HttpError(400, code, '数字参数超出允许范围。');
  return number;
}

function pushSubscription(value) {
  if (!value || typeof value !== 'object' || typeof value.endpoint !== 'string' || !value.keys) throw new HttpError(400, 'PUSH-SUBSCRIPTION-INVALID', '推送订阅格式不合法。');
  let endpoint;
  try { endpoint = new URL(value.endpoint); } catch { throw new HttpError(400, 'PUSH-SUBSCRIPTION-INVALID', '推送 endpoint 不是合法 URL。'); }
  const p256dh = value.keys.p256dh;
  const auth = value.keys.auth;
  if (endpoint.protocol !== 'https:' || !PUSH_HOSTS.has(endpoint.hostname) || value.endpoint.length > 2048 || typeof p256dh !== 'string' || p256dh.length < 80 || p256dh.length > 200 || typeof auth !== 'string' || auth.length < 16 || auth.length > 100) {
    throw new HttpError(400, 'PUSH-SUBSCRIPTION-INVALID', '推送订阅端点或密钥不在允许范围。');
  }
  return { endpoint: value.endpoint, expirationTime: value.expirationTime || null, keys: { p256dh, auth } };
}

function createLivingRoom(options = {}) {
  const houseDir = path.resolve(options.houseDir || process.env.SAMEROOF_HOUSE || path.resolve(__dirname, '../..'));
  const runDir = path.resolve(options.runDir || path.join(process.env.HOME || os.homedir(), '.sameroof', 'run'));
  const dataDir = path.resolve(options.dataDir || path.join(houseDir, 'state'));
  const staticDir = path.join(houseDir, 'apps', 'house');
  for (const dir of [runDir, dataDir, path.join(dataDir, 'living-room')]) fs.mkdirSync(dir, { recursive: true });

  const residents = loadResidents(houseDir);
  const byId = new Map(residents.map(resident => [resident.id, resident]));
  const byName = new Map();
  for (const resident of residents) for (const name of resident._names) byName.set(name, resident);

  const tokenFile = path.join(runDir, 'living-room-tokens.json');
  const tokenStore = options.tokenStore || new TokenStore({ file: tokenFile });
  const notificationClient = options.notificationClient || new PushClient();
  tokenStore.ensure(residents.map(resident => resident.id));

  const db = new Database(path.join(dataDir, 'house.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec([
    'CREATE TABLE IF NOT EXISTS messages(',
    'id TEXT PRIMARY KEY, seq INTEGER UNIQUE, ts TEXT NOT NULL, kind TEXT NOT NULL,',
    'from_id TEXT NOT NULL, to_id TEXT, text TEXT NOT NULL, mentions TEXT NOT NULL, reply_to TEXT, meta TEXT);',
    'CREATE TABLE IF NOT EXISTS deliveries(',
    'message_id TEXT NOT NULL, resident_id TEXT NOT NULL, status TEXT NOT NULL, ts TEXT NOT NULL,',
    'PRIMARY KEY(message_id, resident_id));',
    'CREATE TABLE IF NOT EXISTS approvals(',
    'id TEXT PRIMARY KEY, resident_id TEXT, action TEXT, params_digest TEXT, params TEXT,',
    'status TEXT, decided_by TEXT, created_ts TEXT, expires_ts TEXT, used INTEGER DEFAULT 0);',
    'CREATE TABLE IF NOT EXISTS push_subscriptions(',
    'endpoint TEXT PRIMARY KEY, resident_id TEXT NOT NULL, subscription TEXT NOT NULL, created_ts TEXT NOT NULL, updated_ts TEXT NOT NULL);',
    'CREATE INDEX IF NOT EXISTS push_subscriptions_resident ON push_subscriptions(resident_id);'
  ].join('\n'));

  let seq = db.prepare('SELECT MAX(seq) AS value FROM messages').get().value || 0;
  const insMsg = db.prepare('INSERT INTO messages(id,seq,ts,kind,from_id,to_id,text,mentions,reply_to,meta) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const insDelivery = db.prepare('INSERT OR IGNORE INTO deliveries(message_id,resident_id,status,ts) VALUES(?,?,?,?)');
  const ackDelivery = db.prepare("UPDATE deliveries SET status='read', ts=? WHERE message_id=? AND resident_id=? AND status!='read'");
  const unread = db.prepare("SELECT m.* FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.resident_id=? AND d.status!='read' ORDER BY m.seq");
  const history = db.prepare("SELECT * FROM messages WHERE kind!='dm' AND seq>? ORDER BY seq LIMIT ?");
  const pushForResident = db.prepare('SELECT endpoint,subscription FROM push_subscriptions WHERE resident_id=?');
  const upsertPush = db.prepare(`INSERT INTO push_subscriptions(endpoint,resident_id,subscription,created_ts,updated_ts) VALUES(?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET resident_id=excluded.resident_id,subscription=excluded.subscription,updated_ts=excluded.updated_ts`);
  const deletePush = db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND resident_id=?');

  const listeners = new Set();
  const presence = new Map();
  const sseByResident = new Map();
  const sseByIp = new Map();

  const authFailures = new AuthFailureLimiter({
    limit: options.authFailureLimit || Number(process.env.SAMEROOF_401_LIMIT || 10),
    windowMs: options.authFailureWindowMs || 60000,
    blockMs: options.authBlockMs || 900000
  });
  const sayLimiter = new SlidingWindowLimiter({ limit: options.sayLimit || Number(process.env.SAMEROOF_SAY_LIMIT || 12), windowMs: options.sayWindowMs || 60000 });
  const dmLimiter = new SlidingWindowLimiter({ limit: options.dmLimit || 20, windowMs: 60000 });
  const approvalLimiter = new SlidingWindowLimiter({ limit: options.approvalLimit || 6, windowMs: 60000 });
  const ackLimiter = new SlidingWindowLimiter({ limit: options.ackLimit || 60, windowMs: 60000 });
  const pushLimiter = new SlidingWindowLimiter({ limit: options.pushLimit || 10, windowMs: 60000 });

  function notifyOfflineHumans(row, targets) {
    const from = byId.get(row.from_id);
    for (const residentId of targets) {
      const resident = byId.get(residentId);
      if (!resident || resident.species !== 'human' || presence.get(residentId)?.online) continue;
      for (const saved of pushForResident.all(residentId)) {
        let subscription;
        try { subscription = JSON.parse(saved.subscription); } catch { deletePush.run(saved.endpoint, residentId); continue; }
        setImmediate(async () => {
          try {
            await notificationClient.send(subscription, { title: '同屋 · ' + (from?.name || '家里'), body: String(row.text || '').slice(0, 240), url: '/' });
          } catch (error) {
            if (error instanceof PushClientError && error.status === 410) deletePush.run(saved.endpoint, residentId);
            else console.error('[客厅推送失败]', error.code || error.message);
          }
        });
      }
    }
  }

  function mentionsIn(text) {
    const found = new Set();
    for (const match of String(text).matchAll(/@([^\s@，,。！!？?：:；;]+)/g)) {
      const name = norm(match[1]);
      for (const [candidate, resident] of byName) if (name === candidate || name.startsWith(candidate)) found.add(resident.id);
    }
    return [...found];
  }

  function post(input) {
    if (!byId.has(input.from_id)) throw new HttpError(400, 'ACTOR-INVALID', '发言者不在房子里。');
    if (input.kind === 'dm' && !byId.has(input.to_id)) throw new HttpError(404, 'RECIPIENT-NOT-FOUND', '没这个人。');
    const id = 'msg_' + crypto.randomBytes(12).toString('hex');
    const ts = new Date().toISOString();
    const mentions = input.kind === 'dm' ? [input.to_id] : mentionsIn(input.text).filter(id0 => id0 !== input.from_id);
    const row = {
      id,
      seq: ++seq,
      ts,
      kind: input.kind,
      from_id: input.from_id,
      to_id: input.to_id || null,
      text: input.text,
      mentions,
      reply_to: input.reply_to || null,
      meta: input.meta || null
    };
    const targets = input.kind === 'dm' ? [input.to_id] : residents.map(resident => resident.id).filter(id0 => id0 !== input.from_id);
    db.transaction(() => {
      insMsg.run(id, row.seq, ts, row.kind, row.from_id, row.to_id, row.text, JSON.stringify(mentions), row.reply_to, row.meta ? JSON.stringify(row.meta) : null);
      for (const target of targets) insDelivery.run(id, target, 'queued', ts);
    })();
    if (row.kind !== 'dm') {
      try { fs.appendFileSync(path.join(dataDir, 'living-room', ts.slice(0, 7) + '.jsonl'), JSON.stringify(row) + '\n'); }
      catch (error) { console.error('[客厅归档失败，数据库仍是权威]', error.message); }
    }
    const state = presence.get(row.from_id) || {};
    state.last_said = ts;
    presence.set(row.from_id, state);
    for (const listener of listeners) if (row.kind !== 'dm' || listener.id === row.to_id || listener.id === row.from_id) listener.send(row);
    notifyOfflineHumans(row, targets);
    return row;
  }

  function rateOrThrow(limiter, key, label) {
    const result = limiter.take(key);
    if (!result.allowed) {
      const error = new HttpError(429, 'RATE-LIMITED', label + '太快了，请稍后再试。');
      error.retryAfterMs = result.retryAfterMs;
      throw error;
    }
  }

  function authenticate(req, res, authFailureKey) {
    const preflight = authFailureKey ? authFailures.check(authFailureKey) : { allowed: true };
    if (!preflight.allowed) {
      writeJson(res, 429, { error: { code: 'AUTH-RATE-LIMITED', message: '这个 IP 的失败尝试太多，暂时锁门。' } }, { 'retry-after': String(Math.ceil(preflight.retryAfterMs / 1000)) });
      return null;
    }
    const match = /^Bearer\s+([^\s]+)$/i.exec(String(req.headers.authorization || ''));
    const residentId = match ? tokenStore.authenticate(match[1]) : null;
    const resident = residentId ? byId.get(residentId) : null;
    if (!resident) {
      const failed = authFailureKey ? authFailures.fail(authFailureKey) : { allowed: true };
      const status = failed.allowed ? 401 : 429;
      const code = failed.allowed ? 'TOKEN-INVALID' : 'AUTH-RATE-LIMITED';
      writeJson(res, status, { error: { code, message: failed.allowed ? '门牌不对或已被吊销。' : '这个 IP 的失败尝试太多，暂时锁门。' } }, failed.allowed ? {} : { 'retry-after': String(Math.ceil(failed.retryAfterMs / 1000)) });
      return null;
    }
    if (authFailureKey) authFailures.success(authFailureKey);
    return { resident, secret: match[1] };
  }

  function staticResponse(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const names = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/manifest.json', 'manifest.json'], ['/sw.js', 'sw.js']]);
    if (!names.has(pathname)) return false;
    const file = path.join(staticDir, names.get(pathname));
    if (!fs.existsSync(file)) return false;
    const type = file.endsWith('.json') ? 'application/manifest+json' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
    const body = fs.readFileSync(file);
    res.writeHead(200, { ...securityHeaders(false), 'cache-control': 'no-cache', 'content-type': type, 'content-length': body.length });
    if (req.method === 'HEAD') res.end(); else res.end(body);
    return true;
  }

  const server = http.createServer(async (req, res) => {
    const identity = connectionIdentity(req, options.trustLoopbackProxy !== false);
    const ip = identity.ip;
    try {
      const url = new URL(req.url, 'http://localhost');
      if (staticResponse(req, res, url.pathname)) return;

      const authn = authenticate(req, res, identity.authFailureKey);
      if (!authn) return;
      const me = authn.resident;
      const state = presence.get(me.id) || {};
      state.last_seen = new Date().toISOString();
      presence.set(me.id, state);

      if (req.method === 'GET' && url.pathname === '/me') {
        return writeJson(res, 200, { id: me.id, name: me.name, species: me.species });
      }

      if (req.method === 'POST' && url.pathname === '/say') {
        rateOrThrow(sayLimiter, me.id, '在客厅说话');
        const body = await readJson(req);
        const text = textField(body, 'text');
        const replyTo = body.reply_to == null ? null : String(body.reply_to);
        if (replyTo && !/^msg_[a-f0-9]{24}$/.test(replyTo)) throw new HttpError(400, 'REPLY-ID-INVALID', 'reply_to 不是合法消息 id。');
        return writeJson(res, 200, post({ kind: 'say', from_id: me.id, text, reply_to: replyTo }));
      }

      if (req.method === 'POST' && url.pathname === '/dm') {
        rateOrThrow(dmLimiter, me.id, '发私信');
        const body = await readJson(req);
        const text = textField(body, 'text');
        if (typeof body.to !== 'string' || body.to.length > 100) throw new HttpError(400, 'RECIPIENT-INVALID', '要有合法收件人。');
        const to = byName.get(norm(body.to)) || byId.get(body.to);
        if (!to) throw new HttpError(404, 'RECIPIENT-NOT-FOUND', '没这个人。');
        return writeJson(res, 200, post({ kind: 'dm', from_id: me.id, to_id: to.id, text }));
      }

      if (req.method === 'GET' && url.pathname === '/events') {
        const residentCount = sseByResident.get(me.id) || 0;
        const ipCount = sseByIp.get(ip) || 0;
        if (listeners.size >= SSE_TOTAL_MAX || residentCount >= SSE_RESIDENT_MAX || ipCount >= SSE_IP_MAX) {
          throw new HttpError(429, 'SSE-LIMITED', '实时连接太多，请关闭旧页面后再试。');
        }
        res.writeHead(200, { ...securityHeaders(true), 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        const listener = {
          id: me.id,
          ip,
          send: row => res.write('data: ' + JSON.stringify(row) + '\n\n'),
          close: () => res.end()
        };
        listeners.add(listener);
        sseByResident.set(me.id, residentCount + 1);
        sseByIp.set(ip, ipCount + 1);
        const current = presence.get(me.id) || {};
        current.online = true;
        presence.set(me.id, current);
        res.write(': hi\n\n');
        const keepalive = setInterval(() => {
          if (tokenStore.authenticate(authn.secret) !== me.id) return res.end();
          res.write(': ka\n\n');
        }, 25000);
        let closed = false;
        const cleanup = () => {
          if (closed) return;
          closed = true;
          listeners.delete(listener);
          clearInterval(keepalive);
          const nextResident = Math.max(0, (sseByResident.get(me.id) || 1) - 1);
          const nextIp = Math.max(0, (sseByIp.get(ip) || 1) - 1);
          if (nextResident) sseByResident.set(me.id, nextResident); else sseByResident.delete(me.id);
          if (nextIp) sseByIp.set(ip, nextIp); else sseByIp.delete(ip);
          const status = presence.get(me.id) || {};
          status.online = nextResident > 0;
          presence.set(me.id, status);
        };
        req.on('close', cleanup);
        res.on('close', cleanup);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/history') {
        const since = positiveInt(url.searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER, 'HISTORY-SINCE-INVALID');
        const limit = positiveInt(url.searchParams.get('limit'), 50, 1, 200, 'HISTORY-LIMIT-INVALID');
        return writeJson(res, 200, history.all(since, limit).map(row => ({ ...row, mentions: JSON.parse(row.mentions) })));
      }

      if (req.method === 'GET' && url.pathname === '/inbox') {
        return writeJson(res, 200, unread.all(me.id).map(row => ({ ...row, mentions: JSON.parse(row.mentions), from: byId.get(row.from_id)?.name })));
      }

      if (req.method === 'POST' && url.pathname === '/inbox/ack') {
        rateOrThrow(ackLimiter, me.id, '确认消息');
        const body = await readJson(req);
        if (!Array.isArray(body.ids) || body.ids.length > ACK_MAX || body.ids.some(id => typeof id !== 'string' || !/^msg_[a-f0-9]{24}$/.test(id))) {
          throw new HttpError(400, 'ACK-IDS-INVALID', 'ids 必须是最多 200 个合法消息 id。');
        }
        const ts = new Date().toISOString();
        let changed = 0;
        db.transaction(() => { for (const id of body.ids) changed += ackDelivery.run(ts, id, me.id).changes; })();
        return writeJson(res, 200, { acked: changed });
      }

      if (req.method === 'GET' && url.pathname === '/members') {
        return writeJson(res, 200, residents.map(resident => ({ id: resident.id, name: resident.name, species: resident.species, ...(presence.get(resident.id) || {}) })));
      }

      if (req.method === 'GET' && url.pathname === '/push/vapid-public-key') {
        const value = await notificationClient.publicKey();
        return writeJson(res, 200, value);
      }

      if (req.method === 'POST' && url.pathname === '/push/subscribe') {
        if (me.species !== 'human') throw new HttpError(403, 'PUSH-HUMAN-ONLY', '只有人的房间可以绑定手机推送。');
        rateOrThrow(pushLimiter, me.id, '绑定通知');
        const subscription = pushSubscription(await readJson(req));
        const ts = new Date().toISOString();
        upsertPush.run(subscription.endpoint, me.id, JSON.stringify(subscription), ts, ts);
        return writeJson(res, 200, { subscribed: true });
      }

      if (req.method === 'DELETE' && url.pathname === '/push/subscribe') {
        if (me.species !== 'human') throw new HttpError(403, 'PUSH-HUMAN-ONLY', '只有人的房间可以解绑手机推送。');
        rateOrThrow(pushLimiter, me.id, '解绑通知');
        const body = await readJson(req);
        if (!body || typeof body.endpoint !== 'string' || body.endpoint.length > 2048) throw new HttpError(400, 'PUSH-ENDPOINT-INVALID', '要提供合法 endpoint。');
        return writeJson(res, 200, { removed: deletePush.run(body.endpoint, me.id).changes > 0 });
      }

      if (req.method === 'POST' && url.pathname === '/approval') {
        rateOrThrow(approvalLimiter, me.id, '申请审批');
        const body = await readJson(req);
        if (typeof body.action !== 'string' || !/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/.test(body.action) || body.action.length > 160) {
          throw new HttpError(400, 'APPROVAL-ACTION-INVALID', 'action 必须是合法的命名空间动作。');
        }
        const ttl = positiveInt(body.ttl_seconds, 1800, 30, 3600, 'APPROVAL-TTL-INVALID');
        const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {};
        const paramsJson = JSON.stringify(params);
        const id = 'apr_' + crypto.randomBytes(12).toString('hex');
        const now = Date.now();
        const digest = crypto.createHash('sha256').update(paramsJson).digest('hex');
        db.prepare('INSERT INTO approvals(id,resident_id,action,params_digest,params,status,created_ts,expires_ts) VALUES(?,?,?,?,?,?,?,?)')
          .run(id, me.id, body.action, digest, paramsJson, 'pending', new Date(now).toISOString(), new Date(now + ttl * 1000).toISOString());
        post({ kind: 'system', from_id: me.id, text: me.name + ' 想 ' + body.action + '，等审批。', meta: { approval_id: id, action: body.action, params_digest: digest } });
        return writeJson(res, 200, { approval_id: id, params_digest: digest, expires_in: ttl });
      }

      const approvalMatch = /^\/approval\/(apr_[a-f0-9]{24})$/.exec(url.pathname);
      if (approvalMatch && req.method === 'POST') {
        if (me.species !== 'human') throw new HttpError(403, 'APPROVAL-HUMAN-ONLY', '只有人能审批。');
        rateOrThrow(approvalLimiter, me.id + ':decision', '审批');
        const body = await readJson(req);
        if (!body || !['allow', 'deny'].includes(body.decision)) throw new HttpError(400, 'APPROVAL-DECISION-INVALID', 'decision 只能是 allow 或 deny。');
        const approval = db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalMatch[1]);
        if (!approval) throw new HttpError(404, 'APPROVAL-NOT-FOUND', '没有这个审批。');
        if (approval.status !== 'pending' || Date.parse(approval.expires_ts) < Date.now()) throw new HttpError(409, 'APPROVAL-CLOSED', '审批已过期或已决定。');
        const decision = body.decision === 'allow' ? 'allowed' : 'denied';
        db.prepare('UPDATE approvals SET status=?, decided_by=? WHERE id=?').run(decision, me.id, approval.id);
        post({ kind: 'system', from_id: me.id, text: me.name + (decision === 'allowed' ? '同意' : '拒绝') + '了 ' + (byId.get(approval.resident_id)?.name || approval.resident_id) + ' 的 ' + approval.action + '。', meta: { approval_id: approval.id, decision } });
        return writeJson(res, 200, { approval_id: approval.id, decision, params_digest: approval.params_digest, expires_at: approval.expires_ts, single_use: true });
      }

      if (approvalMatch && req.method === 'GET') {
        const approval = db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalMatch[1]);
        if (!approval) throw new HttpError(404, 'APPROVAL-NOT-FOUND', '没有这个审批。');
        if (me.species !== 'human' && me.id !== approval.resident_id) throw new HttpError(403, 'APPROVAL-PRIVATE', '只有申请者和人类审批者能看详情。');
        const expired = Date.parse(approval.expires_ts) < Date.now();
        return writeJson(res, 200, { ...approval, params: JSON.parse(approval.params), status: expired && approval.status === 'pending' ? 'expired' : approval.status });
      }

      throw new HttpError(404, 'ROUTE-NOT-FOUND', '没这个门。');
    } catch (error) {
      if (res.headersSent) return res.destroy();
      const known = error instanceof HttpError || error instanceof PushClientError;
      const status = known ? error.status : 500;
      const code = known ? error.code : 'INTERNAL-ERROR';
      if (!known) console.error('[客厅请求失败]', error);
      const extra = error.retryAfterMs ? { 'retry-after': String(Math.ceil(error.retryAfterMs / 1000)) } : {};
      writeJson(res, status, { error: { code, message: status === 500 ? '客厅内部出了点问题。' : error.message } }, extra);
    }
  });

  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;

  const expiryTimer = setInterval(() => {
    try { db.prepare("UPDATE approvals SET status='expired' WHERE status='pending' AND expires_ts<?").run(new Date().toISOString()); }
    catch (error) { console.error('[审批过期任务失败]', error.message); }
  }, 60000);
  expiryTimer.unref();

  function listen() {
    const port = options.port === undefined ? Number(process.env.SAMEROOF_PORT || 8790) : options.port;
    const host = options.host || '127.0.0.1';
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve(server.address());
      });
    });
  }

  function close() {
    clearInterval(expiryTimer);
    for (const listener of listeners) {
      try { listener.send({ kind: 'system', text: '客厅暂时关门。' }); } catch {}
      try { listener.close(); } catch {}
    }
    return new Promise(resolve => server.close(() => { db.close(); resolve(); }));
  }

  return { server, listen, close, tokenStore, residents, db, clientIp: req => clientIp(req, options.trustLoopbackProxy !== false) };
}

async function main() {
  const livingRoom = createLivingRoom();
  const address = await livingRoom.listen();
  console.log('同屋·客厅 开门 http://' + address.address + ':' + address.port + ' 住户：' + livingRoom.residents.map(resident => resident.name).join('、'));
  const stop = async () => { await livingRoom.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main().catch(error => { console.error(error); process.exit(1); });

module.exports = { createLivingRoom, clientIp, readJson, HttpError };
