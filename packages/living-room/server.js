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
const { ReportClient } = require('./report-client');
const roomsApi = require('./rooms-api');
const memoryApi = require('./memory-api');
const blackboardApi = require('./blackboard-api');
const quota = require('@sameroof/quota');
const { resolveHouseRoot } = require('@sameroof/house-root');
const jcs = require('@sameroof/jcs');

const RESERVED = new Set(['system', 'all', 'everyone', 'house']);
const MESSAGE_MAX = 8000;
const BODY_MAX = 64 * 1024;
const ACK_MAX = 200;
const SSE_TOTAL_MAX = 100;
const SSE_RESIDENT_MAX = 3;
const SSE_IP_MAX = 10;
const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
// ---- 能力网关接缝（docs/GATEWAY.md §3）：执行型审批、权威决定流、结果投回 ----
const GATEWAY_RESULT_STATUSES = new Set(['succeeded', 'failed', 'denied', 'expired', 'timed_out', 'failed_unknown']);
const GATEWAY_NEXT_KINDS = new Set(['none', 'request_writable_root', 'retry_in_sandbox', 'human_action']);
const GATEWAY_DETAILS_MAX = 4096;
const GATEWAY_SUMMARY_MAX = 2000;
const REQUEST_ID_RE = /^req_[A-Za-z0-9_-]{4,120}$/;
const APPROVAL_ID_RE = /^apr_[a-f0-9]{24}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const SECRET_KEY_RE = /token|authorization|bearer|secret|password|passwd|api[_-]?key|cookie/i;

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
    'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' *; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    ...(api ? { 'cache-control': 'no-store' } : {})
  };
}

// 投回住户前脱敏：token/Authorization 之类字样后面的值、常见 secret 形状。只对短文本用，不保证穷尽——网关那边入库前还要再脱一遍（GATEWAY.md §10）。
function redactText(text) {
  return String(text)
    .replace(/\b(authorization|bearer|token|secret|password|passwd|api[_-]?key|cookie)\b(\s*[:=]\s*|\s+)([A-Za-z0-9_\-.=+/]{8,})/gi, '$1$2[已脱敏]')
    .replace(/\b(sk|ghp|gho|ghu|xox[abp])[-_][A-Za-z0-9_\-]{16,}/g, '[已脱敏]');
}
function redactValue(value, depth = 0) {
  if (depth > 8) return '[太深，略]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 200).map(v => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).slice(0, 200)) out[key] = SECRET_KEY_RE.test(key) ? '[已脱敏]' : redactValue(value[key], depth + 1);
    return out;
  }
  return value;
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
  const houseDir = path.resolve(options.houseDir || resolveHouseRoot());
  const runDir = path.resolve(options.runDir || path.join(process.env.HOME || os.homedir(), '.sameroof', 'run'));
  const dataDir = path.resolve(options.dataDir || path.join(houseDir, 'state'));
  const staticDir = path.join(houseDir, 'apps', 'house');
  for (const dir of [runDir, dataDir, path.join(dataDir, 'living-room')]) fs.mkdirSync(dir, { recursive: true });

  const residents = loadResidents(houseDir);
  const byId = new Map(residents.map(resident => [resident.id, resident]));
  const houseCfg = yaml.load(fs.readFileSync(path.join(houseDir, 'house.yaml'), 'utf8')) || {};
  const byName = new Map();
  for (const resident of residents) for (const name of resident._names) byName.set(name, resident);

  const tokenFile = path.join(runDir, 'living-room-tokens.json');
  const tokenStore = options.tokenStore || new TokenStore({ file: tokenFile });
  const notificationClient = options.notificationClient || new PushClient();
  const reportClient = options.reportClient || new ReportClient(options.report || {});   // V2-LEDGER：broker 只读报表；测试可注入
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
    'CREATE INDEX IF NOT EXISTS push_subscriptions_resident ON push_subscriptions(resident_id);',
    'CREATE TABLE IF NOT EXISTS activity(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, kind TEXT NOT NULL, actor_id TEXT, text TEXT, meta TEXT);',
  ].join('\n'));
  // 网关接缝的表：审批多两列（老库 ALTER 补上）、权威决定流、结果幂等键
  const approvalColumns = new Set(db.prepare('PRAGMA table_info(approvals)').all().map(column => column.name));
  if (!approvalColumns.has('gateway_request_id')) db.exec('ALTER TABLE approvals ADD COLUMN gateway_request_id TEXT');
  if (!approvalColumns.has('digest_kind')) db.exec("ALTER TABLE approvals ADD COLUMN digest_kind TEXT NOT NULL DEFAULT 'legacy'");
  db.exec([
    'CREATE UNIQUE INDEX IF NOT EXISTS approvals_gateway_request ON approvals(gateway_request_id) WHERE gateway_request_id IS NOT NULL;',
    'CREATE TABLE IF NOT EXISTS approval_decisions(',
    'seq INTEGER PRIMARY KEY AUTOINCREMENT, approval_id TEXT NOT NULL, gateway_request_id TEXT NOT NULL, resident_id TEXT NOT NULL, action TEXT NOT NULL,',
    'params_digest TEXT NOT NULL, decision TEXT NOT NULL, remember TEXT NOT NULL, decided_by TEXT NOT NULL, decided_at TEXT NOT NULL, expires_at TEXT NOT NULL, single_use INTEGER NOT NULL DEFAULT 1);',
    'CREATE TABLE IF NOT EXISTS gateway_results(request_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, received_at TEXT NOT NULL);',
  ].join('\n'));

  let seq = db.prepare('SELECT MAX(seq) AS value FROM messages').get().value || 0;
  const insMsg = db.prepare('INSERT INTO messages(id,seq,ts,kind,from_id,to_id,text,mentions,reply_to,meta) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const insDelivery = db.prepare('INSERT OR IGNORE INTO deliveries(message_id,resident_id,status,ts) VALUES(?,?,?,?)');
  const ackDelivery = db.prepare("UPDATE deliveries SET status='read', ts=? WHERE message_id=? AND resident_id=? AND status!='read'");
  const unread = db.prepare("SELECT m.* FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.resident_id=? AND d.status!='read' ORDER BY m.seq");
  const history = db.prepare("SELECT * FROM messages WHERE kind NOT IN ('dm','result') AND seq>? ORDER BY seq LIMIT ?");      // result 类只投申请住户，不进公共历史
  const historyBefore = db.prepare("SELECT * FROM messages WHERE kind NOT IN ('dm','result') AND seq<? ORDER BY seq DESC LIMIT ?");
  const dmHistory = db.prepare("SELECT * FROM messages WHERE kind='dm' AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?)) AND seq<? ORDER BY seq DESC LIMIT ?");
  const adminFullStream = db.prepare("SELECT * FROM messages WHERE seq>? ORDER BY seq LIMIT ?");   // admin: ALL messages including DM and result
  const insActivity = db.prepare('INSERT INTO activity(ts,kind,actor_id,text,meta) VALUES(?,?,?,?,?)');
  const activityBefore = db.prepare('SELECT * FROM activity WHERE seq<? ORDER BY seq DESC LIMIT ?');
  const ACTIVITY_KINDS = new Set(['wake', 'sleep', 'model_call', 'config_change', 'approval_request', 'approval_result', 'error', 'thread_update', 'note']);
  const pushForResident = db.prepare('SELECT endpoint,subscription FROM push_subscriptions WHERE resident_id=?');
  const upsertPush = db.prepare(`INSERT INTO push_subscriptions(endpoint,resident_id,subscription,created_ts,updated_ts) VALUES(?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET resident_id=excluded.resident_id,subscription=excluded.subscription,updated_ts=excluded.updated_ts`);
  const deletePush = db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND resident_id=?');
  const insDecision = db.prepare('INSERT INTO approval_decisions(approval_id,gateway_request_id,resident_id,action,params_digest,decision,remember,decided_by,decided_at,expires_at,single_use) VALUES(?,?,?,?,?,?,?,?,?,?,1)');
  const decisionsAfter = db.prepare('SELECT * FROM approval_decisions WHERE seq>? ORDER BY seq LIMIT ?');
  const approvalByRequest = db.prepare('SELECT * FROM approvals WHERE gateway_request_id=?');
  const getResult = db.prepare('SELECT * FROM gateway_results WHERE request_id=?');
  const insResult = db.prepare('INSERT INTO gateway_results(request_id,message_id,received_at) VALUES(?,?,?)');

  const listeners = new Set();
  function emitActivity({ kind, actor_id, text, meta }) {          // 房子的呼吸：事件流，进 activity 表并推给所有 SSE
    const ts = new Date().toISOString();
    const info = insActivity.run(ts, kind, actor_id || null, text || '', meta ? JSON.stringify(meta) : null);
    const ev = { type: 'activity', seq: info.lastInsertRowid, ts, kind, actor_id, text, meta: meta || null };
    for (const listener of listeners) { try { listener.send(ev); } catch {} }
    return ev;
  }
  const memoryHandle = memoryApi.mount({ houseDir, residents, byId, writeJson, readJson, HttpError, emitActivity });   // 记忆审核队列（W4）：挂在 /rooms/:id/memory/… 下，先于只读的 rooms-api
  const roomsHandle = roomsApi.mount({ houseDir, residents, byId, house: houseCfg, writeJson, readJson, HttpError, emitActivity });   // 房间读 + PUT /rooms/:id/extensions（K1）；要 emitActivity 所以挪到这儿挂
  const blackboard = blackboardApi.mount({ residents, byId, byName, norm, db, writeJson, readJson, HttpError, emitActivity, post });   // 黑板（W7）：tasks 表 + GET/POST /tasks、PATCH /tasks/:id
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
    const isPrivate = input.kind === 'dm' || input.kind === 'result';          // result：网关结果，只给申请住户（GATEWAY.md §3.3）
    if (input.from_id !== 'house' && !byId.has(input.from_id)) throw new HttpError(400, 'ACTOR-INVALID', '发言者不在房子里。');
    if (isPrivate && !byId.has(input.to_id)) throw new HttpError(404, 'RECIPIENT-NOT-FOUND', 'Recipient not found.');
    const id = 'msg_' + crypto.randomBytes(12).toString('hex');
    const ts = new Date().toISOString();
    const mentions = isPrivate ? [input.to_id] : Array.isArray(input.mentions) ? input.mentions.filter(id0 => byId.has(id0) && id0 !== input.from_id) : mentionsIn(input.text).filter(id0 => id0 !== input.from_id);   // 明给 mentions 的（黑板 system 小字 @ 主人）不再从正文里找
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
    const targets = isPrivate ? [input.to_id] : residents.map(resident => resident.id).filter(id0 => id0 !== input.from_id);
    db.transaction(() => {
      insMsg.run(id, row.seq, ts, row.kind, row.from_id, row.to_id, row.text, JSON.stringify(mentions), row.reply_to, row.meta ? JSON.stringify(row.meta) : null);
      for (const target of targets) insDelivery.run(id, target, 'queued', ts);
    })();
    if (!isPrivate) {
      try { fs.appendFileSync(path.join(dataDir, 'living-room', ts.slice(0, 7) + '.jsonl'), JSON.stringify(row) + '\n'); }
      catch (error) { console.error('[客厅归档失败，数据库仍是权威]', error.message); }
    }
    if (row.from_id !== 'house') {
      const state = presence.get(row.from_id) || {};
      state.last_said = ts;
      presence.set(row.from_id, state);
    }
    // DM: push to sender + receiver + all humans (for fold-out display in UI). Other agents don't see it.
    const isHumanListener = id => { const r = byId.get(id); return r && r.species === 'human'; };
    for (const listener of listeners) {
      if (!isPrivate) { listener.send(row); }
      else if (listener.id === row.to_id || listener.id === row.from_id || isHumanListener(listener.id)) { listener.send(row); }
    }
    notifyOfflineHumans(row, targets);
    return row;
  }

  // 投递模式与跳数（维护者 9/6 定的：默认之外，发消息的人可以选"现在就说"还是"等他忙完"）
  const DELIVER_MODES = new Set(['interrupt', 'after_turn', 'inject']);
  function deliveryMeta(body) {
    const meta = {};
    if (body.deliver != null) {
      if (typeof body.deliver !== 'string' || !DELIVER_MODES.has(body.deliver)) throw new HttpError(400, 'DELIVER-INVALID', 'deliver 只能是 interrupt / after_turn / inject。');
      meta.deliver = body.deliver;
    }
    if (body.hop != null) {
      if (!Number.isInteger(body.hop) || body.hop < 0 || body.hop > 99) throw new HttpError(400, 'HOP-INVALID', 'hop 是 0-99 的整数。');
      meta.hop = body.hop;
    }
    return Object.keys(meta).length ? meta : null;
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
    // Also accept ?token= for SSE (browser EventSource cannot set headers). Only on /events.
    const qsToken = (!match && req.url && req.url.startsWith('/events')) ? new URL(req.url, 'http://x').searchParams.get('token') : null;
    const residentId = match ? tokenStore.authenticate(match[1]) : qsToken ? tokenStore.authenticate(qsToken) : null;
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
    // /console → apps/console/index.html (new UI); everything else → apps/house/
    if (pathname === '/console' || pathname === '/console/') {
      const consoleFile = path.join(houseDir, 'apps', 'console', 'index.html');
      if (!fs.existsSync(consoleFile)) return false;
      const body = fs.readFileSync(consoleFile);
      res.writeHead(200, { ...securityHeaders(false), 'cache-control': 'no-cache', 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
      if (req.method === 'GET') res.end(body); else res.end();
      return true;
    }
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

  // ---- 网关内部接口（GATEWAY.md §3.2 / §3.3）：仅 loopback + 网关 service token；token 从文件读，文件没有就整个关着（fail closed）----
  let quotaMemo = null, quotaInflight = null;
  const houseTz = () => { try { return yaml.load(fs.readFileSync(path.join(houseDir, 'house.yaml'), 'utf8')).timezone || 'UTC'; } catch { return 'UTC'; } };
  const gatewayTokenFile = path.resolve(options.gatewayServiceTokenFile || process.env.SAMEROOF_GATEWAY_SERVICE_TOKEN_FILE || path.join(runDir, 'gateway-service.token'));
  function gatewayAuth(req) {
    const remote = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const loopback = remote === '127.0.0.1' || remote === '::1';
    const proxied = req.headers['cf-connecting-ip'] !== undefined || req.headers['x-forwarded-for'] !== undefined;   // 经隧道/反代进来的公网请求也落在 loopback，一律不算本机
    if (!loopback || proxied) throw new HttpError(403, 'GW-NOT-LOOPBACK', '网关内部接口只开给本机。');
    let expected;
    try {
      const stat = fs.statSync(gatewayTokenFile);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new HttpError(503, 'GW-SERVICE-TOKEN-UNSAFE', 'service token 文件权限得是 0600，内部接口先关着。');
      expected = fs.readFileSync(gatewayTokenFile, 'utf8').trim();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, 'GW-SERVICE-TOKEN-MISSING', '网关 service token 还没配好，内部接口先关着。');
    }
    if (expected.length < 32) throw new HttpError(503, 'GW-SERVICE-TOKEN-MISSING', 'service token 太短（要 ≥ 32 字符），内部接口先关着。');
    const match = /^Bearer\s+([^\s]+)$/i.exec(String(req.headers.authorization || ''));
    const given = match ? match[1] : '';
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    if (!given || !crypto.timingSafeEqual(a, b)) throw new HttpError(403, 'GW-AUTH-DENIED', '这不是网关的 service token。');   // 住户 token 也走这里 → 403
  }
  async function gatewayInternal(req, res, url) {
    gatewayAuth(req);
    if (req.method === 'GET' && url.pathname === '/internal/gateway/approval-results') {   // 权威决定流：按 seq 可补读，重启不丢
      const afterSeq = positiveInt(url.searchParams.get('after_seq'), 0, 0, Number.MAX_SAFE_INTEGER, 'GW-AFTER-SEQ-INVALID');
      const limit = positiveInt(url.searchParams.get('limit'), 100, 1, 100, 'GW-LIMIT-INVALID');
      const items = decisionsAfter.all(afterSeq, limit).map(row => ({ ...row, single_use: row.single_use === 1 }));
      return writeJson(res, 200, { items, next_seq: items.length ? items[items.length - 1].seq : afterSeq });
    }
    if (req.method === 'POST' && url.pathname === '/internal/gateway/results') {           // 结果投回：request_id 幂等，只投申请住户
      const body = await readJson(req);
      const requestId = body.request_id;
      if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) throw new HttpError(400, 'GW-RESULT-INVALID', 'request_id 不合法。');
      const existing = getResult.get(requestId);
      if (existing) return writeJson(res, 200, { message_id: existing.message_id, request_id: requestId, received_at: existing.received_at, duplicate: true });
      if (typeof body.approval_id !== 'string' || !APPROVAL_ID_RE.test(body.approval_id)) throw new HttpError(400, 'GW-RESULT-INVALID', 'approval_id 不合法。');
      if (typeof body.resident_id !== 'string' || typeof body.action !== 'string') throw new HttpError(400, 'GW-RESULT-INVALID', '要有 resident_id 和 action。');
      if (!GATEWAY_RESULT_STATUSES.has(body.status)) throw new HttpError(400, 'GW-RESULT-INVALID', 'status 不在 succeeded/failed/denied/expired/timed_out/failed_unknown 里。');
      if (!body.coverage || typeof body.coverage !== 'object' || Array.isArray(body.coverage)) throw new HttpError(400, 'GW-RESULT-INVALID', 'coverage 得是对象。');
      if (!body.next || typeof body.next !== 'object' || !GATEWAY_NEXT_KINDS.has(body.next.kind)) throw new HttpError(400, 'GW-RESULT-INVALID', 'next.kind 不在 none/request_writable_root/retry_in_sandbox/human_action 里。');
      if (typeof body.summary !== 'string' || !body.summary.trim()) throw new HttpError(400, 'GW-RESULT-INVALID', '要有 summary。');
      if (body.details !== undefined && (!body.details || typeof body.details !== 'object')) throw new HttpError(400, 'GW-RESULT-INVALID', 'details 得是对象。');
      const approval = approvalByRequest.get(requestId);
      if (!approval) throw new HttpError(404, 'GW-RESULT-UNKNOWN-REQUEST', '没有这个 request_id 的审批。');
      if (approval.id !== body.approval_id || approval.resident_id !== body.resident_id || approval.action !== body.action) throw new HttpError(409, 'GW-RESULT-MISMATCH', 'approval_id / resident_id / action 与客厅记录不一致。');
      if (!byId.has(approval.resident_id)) throw new HttpError(404, 'RECIPIENT-NOT-FOUND', '申请的住户已不在房子里。');
      const summary = redactText(body.summary).slice(0, GATEWAY_SUMMARY_MAX);
      let details = null;
      if (body.details !== undefined) {
        const text = JSON.stringify(redactValue(body.details));
        details = Buffer.byteLength(text) <= GATEWAY_DETAILS_MAX ? JSON.parse(text) : { truncated: true, bytes: Buffer.byteLength(text), preview: text.slice(0, 3800) };
      }
      const receivedAt = new Date().toISOString();
      let row;
      db.transaction(() => {
        row = post({ kind: 'result', from_id: 'house', to_id: approval.resident_id, text: summary, meta: {
          gateway_request_id: requestId, approval_id: approval.id, action: approval.action, status: body.status,
          coverage: redactValue(body.coverage), next: redactValue(body.next), details, deliver: 'interrupt'
        } });
        insResult.run(requestId, row.id, receivedAt);
        db.prepare('UPDATE approvals SET used=1 WHERE id=?').run(approval.id);
      })();
      // 公共 activity 摘要（实现员 K5 的缝）：只有 status/coverage/next，不带内容、不带路径细节；只在首次投递发（上面 duplicate 已早返回）
      const cov = redactValue(body.coverage) || {}; const done = Array.isArray(cov.completed) ? cov.completed.length : null, want = Array.isArray(cov.requested) ? cov.requested.length : null;
      const covBrief = [cov.executor, done !== null && want !== null ? `${done}/${want}` : null, cov.sandbox === 'unavailable' ? '沙箱不可用' : null].filter(Boolean).join('·');
      emitActivity({ kind: 'approval_result', actor_id: approval.resident_id, text: '🧾 ' + (byId.get(approval.resident_id)?.name || approval.resident_id) + ' 的 ' + approval.action + ' 已执行：' + body.status + (covBrief ? '（' + covBrief + '）' : ''),
        meta: { approval_id: approval.id, gateway_request_id: requestId, resident_id: approval.resident_id, executed: true, status: body.status, coverage: { executor: cov.executor, sandbox: cov.sandbox, network: cov.network, requested: want, completed: done }, next: redactValue(body.next) } });
      return writeJson(res, 200, { message_id: row.id, request_id: requestId, received_at: receivedAt, delivered_to: approval.resident_id, duplicate: false });
    }
    throw new HttpError(404, 'ROUTE-NOT-FOUND', '没这个门。');
  }

  const server = http.createServer(async (req, res) => {
    const identity = connectionIdentity(req, options.trustLoopbackProxy !== false);
    const ip = identity.ip;
    try {
      const url = new URL(req.url, 'http://localhost');
      if (staticResponse(req, res, url.pathname)) return;
      if (url.pathname.startsWith('/internal/gateway/')) return await gatewayInternal(req, res, url);

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
        rateOrThrow(sayLimiter, me.id, 'message rate limit');
        const body = await readJson(req);
        const text = textField(body, 'text');
        const replyTo = body.reply_to == null ? null : String(body.reply_to);
        if (replyTo && !/^msg_[a-f0-9]{16,24}$/.test(replyTo)) throw new HttpError(400, 'REPLY-ID-INVALID', 'reply_to 不是合法消息 id。');
        return writeJson(res, 200, post({ kind: 'say', from_id: me.id, text, reply_to: replyTo, meta: deliveryMeta(body) }));
      }

      if (req.method === 'POST' && url.pathname === '/dm') {
        rateOrThrow(dmLimiter, me.id, 'dm rate limit');
        const body = await readJson(req);
        const text = textField(body, 'text');
        if (typeof body.to !== 'string' || body.to.length > 100) throw new HttpError(400, 'RECIPIENT-INVALID', 'Valid recipient required.');
        const to = byName.get(norm(body.to)) || byId.get(body.to);
        if (!to) throw new HttpError(404, 'RECIPIENT-NOT-FOUND', 'Recipient not found.');
        return writeJson(res, 200, post({ kind: 'dm', from_id: me.id, to_id: to.id, text, meta: deliveryMeta(body) }));
      }

      // ---- 任务派发（多 agent 协作核心 API） ----
      // POST /dispatch { to, task, context?, priority?, sub_tasks? }
      // → 在黑板上创建任务 + DM 通知目标 agent + 返回 task 对象
      if (req.method === 'POST' && url.pathname === '/dispatch') {
        rateOrThrow(sayLimiter, me.id, '派发任务');
        const body = await readJson(req);
        // 必填：to（目标 agent）、task（任务描述）
        if (typeof body.to !== 'string' || !body.to.trim()) throw new HttpError(400, 'DISPATCH-TO-REQUIRED', '要指定目标 agent（to 字段）。');
        if (typeof body.task !== 'string' || !body.task.trim()) throw new HttpError(400, 'DISPATCH-TASK-REQUIRED', '要有任务描述（task 字段）。');
        const target = byName.get(norm(body.to)) || byId.get(body.to);
        if (!target) throw new HttpError(404, 'DISPATCH-TARGET-NOT-FOUND', '找不到目标 agent：' + String(body.to).slice(0, 60));
        // 在黑板上创建任务（复用 blackboard API 的数据结构）
        const taskTitle = body.task.trim().slice(0, 300);
        const taskNotes = typeof body.context === 'string' ? body.context.trim().slice(0, 1000) : null;
        const ts = new Date().toISOString();
        const taskId = 'task_' + Date.now().toString(36) + require('crypto').randomBytes(4).toString('hex').slice(0, 6);
        const taskRow = { id: taskId, title: taskTitle, owner_id: target.id, state: 'open', origin: 'dispatch:' + me.name,
          created_by: me.id, created_ts: ts, updated_ts: ts, due_at: null, due_cron: null,
          accept: null, notes: taskNotes, result: null, blocks_json: null };
        db.prepare('INSERT INTO tasks(id,title,owner_id,state,origin,created_by,created_ts,updated_ts,due_at,due_cron,accept,notes,result,blocks_json,archived_ts) VALUES(@id,@title,@owner_id,@state,@origin,@created_by,@created_ts,@updated_ts,@due_at,@due_cron,@accept,@notes,@result,@blocks_json,NULL)').run(taskRow);
        // DM 通知目标 agent
        const dmText = '📋 ' + me.name + ' 派了一个任务给你：' + taskTitle + (taskNotes ? '\n背景：' + taskNotes.slice(0, 200) : '');
        post({ kind: 'dm', from_id: me.id, to_id: target.id, text: dmText, mentions: [target.id], meta: { dispatch: true, task_id: taskId } });
        // activity
        emitActivity({ kind: 'thread_update', actor_id: me.id, text: '📋 ' + me.name + ' 派任务给 ' + target.name + '：' + taskTitle.slice(0, 60), meta: { task_id: taskId, target_id: target.id, op: 'dispatch' } });
        const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
        return writeJson(res, 200, { dispatched: true, task_id: taskId, target: target.name, task: { ...task, blocks: task.blocks_json ? JSON.parse(task.blocks_json) : [] } });
      }


      if (req.method === 'GET' && url.pathname === '/events') {
        const residentCount = sseByResident.get(me.id) || 0;
        const ipCount = sseByIp.get(ip) || 0;
        if (listeners.size >= SSE_TOTAL_MAX || residentCount >= SSE_RESIDENT_MAX || ipCount >= SSE_IP_MAX) {
          throw new HttpError(429, 'SSE-LIMITED', 'Too many SSE connections.');
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

      if (url.pathname.startsWith('/rooms/')) { if (await memoryHandle(req, url, me, res)) return; if (await roomsHandle(req, url, me, res)) return; }
      if (url.pathname === '/tasks' || url.pathname.startsWith('/tasks/')) { if (await blackboard.handle(req, url, me, res)) return; }

      if (req.method === 'POST' && url.pathname === '/activity') {           // 住户（适配器）报自己的事件；actor 只认 token
        const body = await readJson(req);
        if (!ACTIVITY_KINDS.has(body.kind)) throw new HttpError(400, 'ACTIVITY-KIND-INVALID', 'Unknown activity kind.');
        return writeJson(res, 200, emitActivity({ kind: body.kind, actor_id: me.id, text: String(body.text || '').slice(0, 500), meta: body.meta && typeof body.meta === 'object' ? body.meta : null }));
      }
      if (req.method === 'GET' && url.pathname === '/activity') {
        const before = positiveInt(url.searchParams.get('before'), Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER, 'ACTIVITY-BEFORE-INVALID');
        const limit = positiveInt(url.searchParams.get('limit'), 50, 1, 200, 'ACTIVITY-LIMIT-INVALID');
        const kind = url.searchParams.get('kind');
        return writeJson(res, 200, activityBefore.all(before, limit).filter(r => !kind || r.kind === kind).map(r => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null, actor: byId.get(r.actor_id)?.name })));
      }
      if (req.method === 'GET' && url.pathname === '/quota') {                // V2-Q：配额气象台，只给家人；60 秒内重复问直接给上次的，?fresh=1 强刷
        if (me.species !== 'human') throw new HttpError(403, 'QUOTA-HUMAN-ONLY', '只有家人能看配额。');
        const fresh = url.searchParams.get('fresh') === '1';
        if (!fresh && quotaMemo && Date.now() - quotaMemo.at < 60000) return writeJson(res, 200, quotaMemo.body);
        if (!quotaInflight) quotaInflight = quota.snapshot({ residents, tz: houseTz(), cachePath: path.join(dataDir, 'quota-cache.json'), env: process.env, providers: options.quotaProviders, timeoutMs: options.quotaTimeoutMs || 15000 }).finally(() => { quotaInflight = null; });
        const body = await quotaInflight;
        quotaMemo = { at: Date.now(), body };
        return writeJson(res, 200, body);
      }
      if (req.method === 'GET' && url.pathname === '/runs') {                 // V2-4A：运行记录（state/runs/<resident>.jsonl）；只给家人看
        if (me.species !== 'human') throw new HttpError(403, 'RUNS-HUMAN-ONLY', '只有家人能看运行记录。');
        const limit = positiveInt(url.searchParams.get('limit'), 20, 1, 200, 'RUNS-LIMIT-INVALID');
        const who = url.searchParams.get('resident');
        const targets = who ? [byId.get(who) || byName.get(norm(who))].filter(Boolean) : residents.filter(r => r.species !== 'human');
        if (who && !targets.length) throw new HttpError(404, 'RUNS-RESIDENT-NOT-FOUND', '没这个住户。');
        const rows = targets.flatMap(r => roomsApi.readJsonl(path.join(houseDir, 'state', 'runs', `${r.id}.jsonl`), limit))
          .map(r => ({ id: r.id, resident_id: r.resident_id, resident: byId.get(r.resident_id)?.name || null, ts: r.ts, reason: r.reason || null, lane: r.lane || null, status: r.status || null, ms: r.ms ?? null, usage: r.usage || null, model_calls: r.model_calls || 0, ...(r.error ? { error: String(r.error) } : {}) }))
          .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || ''))).slice(0, limit);
        return writeJson(res, 200, rows);
      }
      // V2-COST：按天 × 住户聚合 token 用量。数据源是房子自己的账 state/runs/*.jsonl（每次醒来记的 usage，已含 broker 归一化的 cached_tokens），
      // 不开 broker 的 ledger（那是它的私有状态，0700 另一个用户，DECISIONS #11）；且 ledger 只有走 broker 的住户，claude-code / pi 住户不在里面。
      // 天按房子的账务时区切（house.timezone），跟"今日预算"同一口径。
      if (req.method === 'GET' && url.pathname === '/cost') {
        if (me.species !== 'human') throw new HttpError(403, 'COST-HUMAN-ONLY', '只有家人能看花销。');
        const days = positiveInt(url.searchParams.get('days'), 7, 1, 90, 'COST-DAYS-INVALID');
        const tz = houseTz();
        const dayOf = ts => { try { return new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(new Date(ts)); } catch { return null; } };
        const today = dayOf(Date.now());
        const dayList = []; for (let i = days - 1; i >= 0; i--) { const d = new Date(Date.parse(today + 'T12:00:00Z') - i * 86400000); dayList.push(d.toISOString().slice(0, 10)); }
        const since = dayList[0];
        const agents = residents.filter(r => r.species !== 'human');
        const perResident = agents.map(r => {
          const byDay = Object.fromEntries(dayList.map(d => [d, { day: d, wakes: 0, calls: 0, with_usage: 0, input: 0, output: 0, cached: 0, cache_creation: 0 }]));
          for (const run of roomsApi.readJsonl(path.join(houseDir, 'state', 'runs', `${r.id}.jsonl`), 5000)) {
            const d = run.ts && dayOf(run.ts); if (!d || d < since || !byDay[d]) continue;
            const b = byDay[d]; b.wakes++; b.calls += Number(run.model_calls) || 0;
            const u = run.usage; if (!u) continue; b.with_usage++;
            b.input += Number(u.prompt_tokens ?? u.input_tokens) || 0; b.output += Number(u.completion_tokens ?? u.output_tokens) || 0;
            b.cached += Number(u.cached_tokens) || 0; b.cache_creation += Number(u.cache_creation_tokens) || 0;
          }
          const total = Object.values(byDay).reduce((a, b) => ({ wakes: a.wakes + b.wakes, calls: a.calls + b.calls, with_usage: a.with_usage + b.with_usage, input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached, cache_creation: a.cache_creation + b.cache_creation }), { wakes: 0, calls: 0, with_usage: 0, input: 0, output: 0, cached: 0, cache_creation: 0 });
          return { resident_id: r.id, resident: r.name, runtime: r.runtime || null, days: dayList.map(d => byDay[d]), total };
        });
        // ledger 段：broker 自己算好的凭证账本（只有走 broker 的住户）。拉不到不炸，只带 ledger_error 让前端说明。
        let ledger = null, ledgerError = null;
        try { ledger = await reportClient.daily({ days, tz }); } catch (e) { ledgerError = { code: e.code || 'REPORT-ERROR', message: String(e.message || e).slice(0, 200) }; }
        if (ledger && Array.isArray(ledger.residents)) for (const r of ledger.residents) r.resident = byId.get(r.resident_id)?.name || r.resident_id;
        return writeJson(res, 200, { days: dayList, timezone: tz, source: 'state/runs', residents: perResident, ledger, ledger_error: ledgerError });
      }
      // V2-SEARCH：跨班搜索。扫 state/shift-<id>.jsonl（本班活的）+ state/shifts/*.jsonl（归档）；回放 retract；只搜 user/assistant（system 是人设不是对话）。
      // 人 only。命中按 ts 倒序；片段取第一处命中前后各 50 字。resident 可给名字或 id。
      if (req.method === 'GET' && url.pathname === '/search') {
        if (me.species !== 'human') throw new HttpError(403, 'SEARCH-HUMAN-ONLY', '只有家人能搜历史。');
        const q = String(url.searchParams.get('q') || '').trim();
        if (!q || q.length > 200) throw new HttpError(400, 'SEARCH-Q-INVALID', 'q 必填，200 字以内。');
        const limit = positiveInt(url.searchParams.get('limit'), 20, 1, 200, 'SEARCH-LIMIT-INVALID');
        const who = url.searchParams.get('resident');
        const target = who ? (byId.get(who) || byName.get(norm(who))) : null;
        if (who && !target) throw new HttpError(404, 'SEARCH-RESIDENT-NOT-FOUND', '没这个住户。');
        const stateDir = path.join(houseDir, 'state');
        const files = [];
        try { for (const f of fs.readdirSync(stateDir)) if (/^shift-.+\.jsonl$/.test(f)) files.push({ file: path.join(stateDir, f), rid: f.slice(6, -6), live: true }); } catch {}
        try { for (const f of fs.readdirSync(path.join(stateDir, 'shifts'))) { const m = /^(.+?)-shift-(.+)\.jsonl$/.exec(f); if (m) files.push({ file: path.join(stateDir, 'shifts', f), rid: m[2], live: false, archived_at: m[1] }); } } catch {}
        const needle = q.toLowerCase(); const hits = [];
        for (const f of files) {
          if (target && f.rid !== target.id) continue;
          let text; try { text = fs.readFileSync(f.file, 'utf8'); } catch { continue; }
          const msgs = [];                                                   // 回放：msg 追加，retract 撤最后一条 user（与 shift-messages.js 的恢复逻辑一致）
          for (const line of text.split('\n')) { if (!line.trim()) continue; let e; try { e = JSON.parse(line); } catch { continue; }
            if (e.op === 'msg' && e.role && e.content != null) msgs.push(e); else if (e.op === 'retract' && msgs.length && msgs[msgs.length - 1].role === 'user') msgs.pop(); }
          msgs.forEach((m, turn) => {
            if (m.role === 'system') return;
            const c = String(m.content); const i = c.toLowerCase().indexOf(needle); if (i < 0) return;
            hits.push({ resident_id: f.rid, resident: byId.get(f.rid)?.name || f.rid, shift_file: path.relative(houseDir, f.file), live: f.live, ts: m.ts || null, role: m.role, turn,
              content_snippet: (i > 50 ? '…' : '') + c.slice(Math.max(0, i - 50), i + needle.length + 50) + (i + needle.length + 50 < c.length ? '…' : '') });
          });
        }
        hits.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
        return writeJson(res, 200, { q, total: hits.length, files_scanned: files.filter(f => !target || f.rid === target.id).length, hits: hits.slice(0, limit) });
      }
      if (req.method === 'GET' && url.pathname === '/dm/history') {
        const withName = url.searchParams.get('with') || ''; const other = byId.get(withName) || byName.get(withName.normalize('NFKC').toLowerCase());
        if (!other) throw new HttpError(404, 'RECIPIENT-NOT-FOUND', 'Recipient not found.');
        const before = positiveInt(url.searchParams.get('before'), Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER, 'HISTORY-BEFORE-INVALID');
        const limit = positiveInt(url.searchParams.get('limit'), 50, 1, 200, 'HISTORY-LIMIT-INVALID');
        return writeJson(res, 200, dmHistory.all(me.id, other.id, other.id, me.id, before, limit).reverse().map(row => ({ ...row, mentions: JSON.parse(row.mentions), meta: row.meta ? JSON.parse(row.meta) : null })));
      }
      if (req.method === 'GET' && url.pathname === '/history' && url.searchParams.has('before')) {
        const before = positiveInt(url.searchParams.get('before'), Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER, 'HISTORY-BEFORE-INVALID');
        const limit = positiveInt(url.searchParams.get('limit'), 50, 1, 200, 'HISTORY-LIMIT-INVALID');
        return writeJson(res, 200, historyBefore.all(before, limit).reverse().map(row => ({ ...row, mentions: JSON.parse(row.mentions), meta: row.meta ? JSON.parse(row.meta) : null })));
      }

      // Admin full message stream: all messages including DMs — requires human identity
      if (req.method === 'GET' && url.pathname === '/admin/messages') {
        if (me.species !== 'human') throw new HttpError(403, 'ADMIN-HUMANS-ONLY', 'Admin endpoints require human identity.');
        const since = positiveInt(url.searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER, 'ADMIN-SINCE-INVALID');
        const limit = positiveInt(url.searchParams.get('limit'), 200, 1, 500, 'ADMIN-LIMIT-INVALID');
        return writeJson(res, 200, adminFullStream.all(since, limit).map(row => ({ ...row, mentions: JSON.parse(row.mentions), meta: row.meta ? JSON.parse(row.meta) : null })));
      }

      if (req.method === 'GET' && url.pathname === '/history') {
        const since = positiveInt(url.searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER, 'HISTORY-SINCE-INVALID');
        const limit = positiveInt(url.searchParams.get('limit'), 50, 1, 200, 'HISTORY-LIMIT-INVALID');
        return writeJson(res, 200, history.all(since, limit).map(row => ({ ...row, mentions: JSON.parse(row.mentions), meta: row.meta ? JSON.parse(row.meta) : null })));
      }

      if (req.method === 'GET' && url.pathname === '/inbox') {
        return writeJson(res, 200, unread.all(me.id).map(row => ({ ...row, mentions: JSON.parse(row.mentions), meta: row.meta ? JSON.parse(row.meta) : null, from: row.from_id === 'house' ? '房子' : byId.get(row.from_id)?.name })));
      }

      if (req.method === 'POST' && url.pathname === '/inbox/ack') {
        rateOrThrow(ackLimiter, me.id, '确认消息');
        const body = await readJson(req);
        if (!Array.isArray(body.ids) || body.ids.length > ACK_MAX || body.ids.some(id => typeof id !== 'string' || !/^msg_[a-f0-9]{16,24}$/.test(id))) {
          throw new HttpError(400, 'ACK-IDS-INVALID', 'ids 必须是最多 200 个合法消息 id。');
        }
        const ts = new Date().toISOString();
        let changed = 0;
        db.transaction(() => { for (const id of body.ids) changed += ackDelivery.run(ts, id, me.id).changes; })();
        return writeJson(res, 200, { acked: changed });
      }

      if (req.method === 'GET' && url.pathname === '/members') {
        return writeJson(res, 200, residents.map(resident => ({ id: resident.id, name: resident.name, species: resident.species, avatar: (resident.avatar || ((resident.extensions || {})['dev.sameroof.avatar']) || null), ...(presence.get(resident.id) || {}) })));
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

      // V2-AP：待审列表。只给人看；默认 status=pending，也可 all/allowed/denied/expired。顺手把过期的 pending 标成 expired（网关那边本来就按 expires 拒，这里只是让人看得准）。
      if (req.method === 'GET' && url.pathname === '/approval') {
        if (me.species !== 'human') throw new HttpError(403, 'APPROVAL-HUMAN-ONLY', '只有人能看审批列表。');
        const status = url.searchParams.get('status') || 'pending';
        if (!['pending', 'all', 'allowed', 'denied', 'expired'].includes(status)) throw new HttpError(400, 'APPROVAL-STATUS-INVALID', 'status 只能是 pending / all / allowed / denied / expired。');
        const limit = positiveInt(url.searchParams.get('limit'), 50, 1, 200, 'APPROVAL-LIMIT-INVALID');
        db.prepare("UPDATE approvals SET status='expired' WHERE status='pending' AND expires_ts < ?").run(new Date().toISOString());
        const rows = (status === 'all' ? db.prepare('SELECT * FROM approvals ORDER BY created_ts DESC LIMIT ?').all(limit)
          : db.prepare('SELECT * FROM approvals WHERE status=? ORDER BY created_ts DESC LIMIT ?').all(status, limit));
        return writeJson(res, 200, rows.map(a => ({ approval_id: a.id, resident_id: a.resident_id, resident_name: byId.get(a.resident_id)?.name || a.resident_id, action: a.action, params: (() => { try { return JSON.parse(a.params); } catch { return null; } })(), params_digest: a.params_digest, status: a.status, decided_by: a.decided_by || null, created_ts: a.created_ts, expires_ts: a.expires_ts, gateway_request_id: a.gateway_request_id || null, digest_kind: a.digest_kind })));
      }
      if (req.method === 'POST' && url.pathname === '/approval') {
        rateOrThrow(approvalLimiter, me.id, '申请审批');
        const body = await readJson(req);
        if (typeof body.action !== 'string' || !/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/.test(body.action) || body.action.length > 160) {
          throw new HttpError(400, 'APPROVAL-ACTION-INVALID', 'action 必须是合法的命名空间动作。');
        }
        const ttl = positiveInt(body.ttl_seconds, 1800, 30, 3600, 'APPROVAL-TTL-INVALID');
        const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {};
        // 执行型审批（带 gateway_request_id + params_digest）：客厅按 RFC 8785 自己重算摘要，不信 body；旧客户端不带的走 JSON.stringify 摘要，标 legacy，网关不消费。
        const executable = body.gateway_request_id !== undefined || body.params_digest !== undefined;
        let paramsJson, paramsDigest, digestKind = 'legacy', gatewayRequestId = null;
        if (executable) {
          if (typeof body.gateway_request_id !== 'string' || !REQUEST_ID_RE.test(body.gateway_request_id)) throw new HttpError(400, 'APPROVAL-REQUEST-ID-INVALID', 'gateway_request_id 得是 req_ 开头的合法 id，且要和 params_digest 一起给。');
          if (typeof body.params_digest !== 'string' || !DIGEST_RE.test(body.params_digest)) throw new HttpError(400, 'APPROVAL-DIGEST-INVALID', 'params_digest 得是 64 位小写 hex，且要和 gateway_request_id 一起给。');
          if (!body.params || typeof body.params !== 'object' || Array.isArray(body.params)) throw new HttpError(400, 'APPROVAL-PARAMS-INVALID', '执行型审批的 params 得是对象。');
          try { paramsJson = jcs.canonicalize(params); paramsDigest = jcs.digest(params); }
          catch (error) { throw new HttpError(400, 'APPROVAL-PARAMS-INVALID', 'params 不能做 JCS 规范化：' + error.message); }
          if (paramsDigest !== body.params_digest) throw new HttpError(400, 'APPROVAL-DIGEST-MISMATCH', 'params_digest 与客厅按 RFC 8785 重算的不一致，不创建审批。');
          if (approvalByRequest.get(body.gateway_request_id)) throw new HttpError(409, 'APPROVAL-REQUEST-DUPLICATE', '这个 gateway_request_id 已经有审批了，一个 request 只能绑一个审批。');
          digestKind = 'jcs';
          gatewayRequestId = body.gateway_request_id;
        } else {
          paramsJson = JSON.stringify(params);
          paramsDigest = crypto.createHash('sha256').update(paramsJson).digest('hex');
        }
        const id = 'apr_' + crypto.randomBytes(12).toString('hex');
        const now = Date.now();
        const expiresAt = new Date(now + ttl * 1000).toISOString();
        try {
          db.prepare('INSERT INTO approvals(id,resident_id,action,params_digest,params,status,created_ts,expires_ts,gateway_request_id,digest_kind) VALUES(?,?,?,?,?,?,?,?,?,?)')
            .run(id, me.id, body.action, paramsDigest, paramsJson, 'pending', new Date(now).toISOString(), expiresAt, gatewayRequestId, digestKind);
        } catch (error) {
          if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) throw new HttpError(409, 'APPROVAL-REQUEST-DUPLICATE', '这个 gateway_request_id 已经有审批了，一个 request 只能绑一个审批。');
          throw error;
        }
        const approvalMeta = { approval_id: id, action: body.action, params_digest: paramsDigest, gateway_request_id: gatewayRequestId, digest_kind: digestKind };
        post({ kind: 'system', from_id: me.id, text: me.name + ' 想 ' + body.action + '，等审批。', meta: approvalMeta });
        emitActivity({ kind: 'approval_request', actor_id: me.id, text: me.name + ' 想 ' + body.action + '，等审批。', meta: { ...approvalMeta, waiting_on: 'human' } });
        return writeJson(res, 200, { approval_id: id, params_digest: paramsDigest, expires_in: ttl, expires_at: expiresAt, gateway_request_id: gatewayRequestId, digest_kind: digestKind });
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
        const decidedAt = new Date().toISOString();
        // TODO(实现员 K2)：决定接口暂不收 remember 字段，先固定 once；按钮上线后在这里收 remember，并按 house 的 approval_memory ceiling 裁。
        const remember = 'once';
        let decisionSeq = null;
        db.transaction(() => {                                                   // 人的决定与权威决定流同一事务落盘；legacy 摘要的审批不进流（网关不得消费）
          db.prepare('UPDATE approvals SET status=?, decided_by=? WHERE id=?').run(decision, me.id, approval.id);
          if (approval.digest_kind === 'jcs' && approval.gateway_request_id) {
            decisionSeq = Number(insDecision.run(approval.id, approval.gateway_request_id, approval.resident_id, approval.action, approval.params_digest, decision, remember, me.id, decidedAt, approval.expires_ts).lastInsertRowid);
          }
        })();
        const decisionMeta = { approval_id: approval.id, decision, gateway_request_id: approval.gateway_request_id || null, digest_kind: approval.digest_kind };
        post({ kind: 'system', from_id: me.id, text: me.name + (decision === 'allowed' ? '同意' : '拒绝') + '了 ' + (byId.get(approval.resident_id)?.name || approval.resident_id) + ' 的 ' + approval.action + '。', meta: decisionMeta });
        emitActivity({ kind: 'approval_result', actor_id: me.id, text: me.name + (decision === 'allowed' ? '同意' : '拒绝') + '了 ' + (byId.get(approval.resident_id)?.name || approval.resident_id) + ' 的 ' + approval.action + '。', meta: { ...decisionMeta, resident_id: approval.resident_id } });
        return writeJson(res, 200, { approval_id: approval.id, decision, params_digest: approval.params_digest, expires_at: approval.expires_ts, single_use: true, remember, gateway_request_id: approval.gateway_request_id || null, decision_seq: decisionSeq, decided_at: decidedAt });
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
      writeJson(res, status, { error: { code, message: status === 500 ? '客厅内部出了点问题。' : error.message, ...(known && Array.isArray(error.issues) ? { issues: error.issues } : {}) } }, extra);
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
  try { const n = blackboard.archive(); if (n) console.log('[黑板] 收起了 ' + n + ' 件满 7 天的 done/dropped'); } catch (error) { console.error('[黑板归档失败]', error.message); }   // 启动时一次，之后每小时一次
  const archiveTimer = setInterval(() => { try { blackboard.archive(); } catch (error) { console.error('[黑板归档失败]', error.message); } }, 3600000);
  archiveTimer.unref();

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
    clearInterval(archiveTimer);
    for (const listener of listeners) {
      try { listener.send({ kind: 'system', text: '客厅暂时关门。' }); } catch {}
      try { listener.close(); } catch {}
    }
    return new Promise(resolve => server.close(() => { db.close(); resolve(); }));
  }

  return { server, listen, close, tokenStore, residents, db, gatewayTokenFile, blackboard, clientIp: req => clientIp(req, options.trustLoopbackProxy !== false) };
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
