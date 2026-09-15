#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const yaml = require('js-yaml');
const jcs = require('@sameroof/jcs');
const { validateHouse, PERMISSION_RANK } = require('@sameroof/schema');

const MAX_BODY = 256 * 1024;
const MAX_CONTENT = 1024 * 1024;
const FS_READ_MAX = 1200;
const MAX_OUTPUT = 256 * 1024;
const HARD_TIMEOUT = 10 * 60 * 1000;
const REQUEST_ID = /^req_[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const RESIDENT_ID = /^resident_[a-z0-9][a-z0-9_-]{2,95}$/;
const ACTIONS = new Set(['core.fs.read', 'core.fs.write', 'core.exec', 'core.exec.ro']);   // core.exec.ro: RFC 2026-09-15 §2.2 — read-only sandbox by construction
const PROTECTED_NAMES = new Set(['house.yaml', 'house.lock', 'room.yaml', '.sameroof']);

class GatewayError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}

function json(res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, ...headers });
  res.end(body);
}
function errorJson(res, error) {
  const e = error instanceof GatewayError ? error : new GatewayError(500, 'GW-INTERNAL', '网关内部错误。');
  if (!(error instanceof GatewayError)) console.error('[gateway]', error);
  json(res, e.status, { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } });
}
function now() { return new Date().toISOString(); }
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function safeText(value, limit = 400) { return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit); }

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new GatewayError(413, 'GW-BODY-TOO-LARGE', '请求体超过 256 KiB。')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(jcs.parseStrict(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new GatewayError(400, 'GW-PARAMS-INVALID', '请求体不是严格 JSON：' + e.message)); }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const raw = String(req.headers.authorization || '');
  const m = /^Bearer\s+([^\s]+)$/i.exec(raw);
  if (!m) throw new GatewayError(401, 'GW-AUTH-DENIED', '缺少网关 Bearer token。');
  return m[1];
}
function isLoopback(req) {
  const address = req.socket && req.socket.remoteAddress;
  return !address || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

class State {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intents (
        request_id TEXT PRIMARY KEY, resident_id TEXT NOT NULL, run_id TEXT, action TEXT NOT NULL,
        params_json TEXT NOT NULL, params_digest TEXT NOT NULL, target_digest TEXT NOT NULL,
        expires_at TEXT NOT NULL, status TEXT NOT NULL, approval_id TEXT, approval_expires_at TEXT,
        result_json TEXT, policy_digest TEXT, policy_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, resident_id TEXT NOT NULL, action TEXT NOT NULL,
        params_digest TEXT NOT NULL, decision TEXT NOT NULL, remember TEXT NOT NULL, decided_by TEXT,
        decided_at TEXT NOT NULL, expires_at TEXT, single_use INTEGER NOT NULL DEFAULT 1, consumed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS adapter_tokens (resident_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS results (request_id TEXT PRIMARY KEY, message_id TEXT, result_json TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, event TEXT NOT NULL, request_id TEXT, approval_id TEXT, resident_id TEXT, action TEXT, params_digest TEXT, target_digest TEXT, status TEXT, details_json TEXT);
      CREATE TABLE IF NOT EXISTS cursors (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    `);
    const resultColumns = this.db.prepare('PRAGMA table_info(results)').all().map(x => x.name);
    if (!resultColumns.includes('delivered_at')) this.db.exec('ALTER TABLE results ADD COLUMN delivered_at TEXT');
    const intentColumns = this.db.prepare('PRAGMA table_info(intents)').all().map(x => x.name);
    if (!intentColumns.includes('policy_digest')) this.db.exec('ALTER TABLE intents ADD COLUMN policy_digest TEXT');
    if (!intentColumns.includes('policy_json')) this.db.exec('ALTER TABLE intents ADD COLUMN policy_json TEXT');
    // RFC 2026-09-15-gateway-allow: contract A + /output channel
    if (!intentColumns.includes('decision_source')) this.db.exec("ALTER TABLE intents ADD COLUMN decision_source TEXT NOT NULL DEFAULT 'human'");
    if (!intentColumns.includes('executed_at')) this.db.exec('ALTER TABLE intents ADD COLUMN executed_at TEXT');
    if (!intentColumns.includes('output_json')) this.db.exec('ALTER TABLE intents ADD COLUMN output_json TEXT');
    if (!intentColumns.includes('output_reads')) this.db.exec('ALTER TABLE intents ADD COLUMN output_reads INTEGER NOT NULL DEFAULT 0');
    // Per-row snapshot of the retention promise made at execution time. Policy changes later may tighten, never extend.
    if (!intentColumns.includes('output_expires_at')) this.db.exec('ALTER TABLE intents ADD COLUMN output_expires_at TEXT');
    if (!intentColumns.includes('output_max_reads')) this.db.exec('ALTER TABLE intents ADD COLUMN output_max_reads INTEGER');
  }
  audit(event, item = {}) {
    this.db.prepare('INSERT INTO audit(ts,event,request_id,approval_id,resident_id,action,params_digest,target_digest,status,details_json) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(now(), event, item.request_id || null, item.approval_id || null, item.resident_id || null, item.action || null, item.params_digest || null, item.target_digest || null, item.status || null, JSON.stringify(item.details || {}));
  }
  close() { this.db.close(); }
}

function parseHouse(houseDir) {
  try { return yaml.load(fs.readFileSync(path.join(houseDir, 'house.yaml'), 'utf8')) || {}; }
  catch { return {}; }
}

function normalizeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw new GatewayError(400, 'GW-PATH-OUTSIDE', '路径必须是相对路径，不能含空段、反斜杠或 ..。');
  const parts = value.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) throw new GatewayError(400, 'GW-PATH-OUTSIDE', '路径不能含空段、`.` 或 `..`。');
  return parts.join('/');
}
function protectedPath(relative) {
  const parts = relative.split('/');
  if (parts.includes('.sameroof') || parts.some(p => p === '.env' || p.startsWith('.env.') || p === '.envrc' || p.endsWith('.env'))) return true;
  const git = parts.indexOf('.git'); if (git >= 0 && (parts[git + 1] === 'hooks' || parts[git + 1] === 'config')) return true;
  return parts.some(p => PROTECTED_NAMES.has(p));
}

function collectRoomDirs(houseDir) {
  const out = new Map();
  const rooms = path.join(houseDir, 'rooms');
  try {
    for (const e of fs.readdirSync(rooms, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const file = path.join(rooms, e.name, 'room.yaml');
      try { const r = yaml.load(fs.readFileSync(file, 'utf8')); if (r?.id) out.set(r.id, path.join(rooms, e.name)); } catch {}
    }
  } catch {}
  return out;
}

function loadPolicyFiles(houseDir, digest = null) {
  const house = parseHouse(houseDir);
  const rooms = collectRoomDirs(houseDir);
  const roomConfigs = new Map();
  for (const [id, dir] of rooms) {
    let config; try { config = yaml.load(fs.readFileSync(path.join(dir, 'room.yaml'), 'utf8')) || {}; }
    catch (error) { throw new GatewayError(503, 'GW-POLICY-DENIED', 'room.yaml 无法安全载入：' + error.message); }
    roomConfigs.set(id, config);
  }
  return { digest, house, rooms, roomConfigs };
}
function serializePolicy(policy) {
  return JSON.stringify({ digest: policy.digest, house: policy.house, rooms: Object.fromEntries(policy.rooms), roomConfigs: Object.fromEntries(policy.roomConfigs) });
}
function deserializePolicy(text) {
  const value = JSON.parse(text);
  return { digest: value.digest, house: value.house, rooms: new Map(Object.entries(value.rooms || {})), roomConfigs: new Map(Object.entries(value.roomConfigs || {})) };
}

function resultShell(status, executor = 'none', next = { kind: 'none' }) {
  return { status, coverage: { executor, sandbox: executor === 'bwrap' ? 'enforced' : 'not_applicable', network: 'denied', requested: [], completed: [], stdout_truncated: false, stderr_truncated: false, ...(executor === 'bwrap' ? { protected_name_creation: 'not_enforced' } : {}) }, next };
}

function minimalRuntimeArgs() {
  const args = ['--tmpfs', '/', '--dir', '/usr'];
  for (const name of ['bin', 'sbin', 'lib', 'lib64', 'share']) {
    const source = '/usr/' + name;
    try {
      const st = fs.lstatSync(source);
      if (st.isSymbolicLink()) args.push('--symlink', fs.readlinkSync(source), source);
      else args.push('--ro-bind', source, source);
    } catch {}
  }
  for (const name of ['bin', 'sbin', 'lib', 'lib64']) {
    const source = '/' + name;
    try {
      const st = fs.lstatSync(source);
      if (st.isSymbolicLink()) args.push('--symlink', fs.readlinkSync(source), source);
      else args.push('--ro-bind', source, source);
    } catch {}
  }
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  return args;
}

function destinationDirs(paths) {
  const dirs = new Set();
  for (const item of paths) {
    let current = path.resolve(item);
    const stack = [];
    while (current !== '/' && !['/usr', '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/lib64', '/usr/share', '/bin', '/sbin', '/lib', '/lib64', '/proc', '/dev', '/tmp'].includes(current)) { stack.push(current); current = path.dirname(current); }
    for (const dir of stack.reverse()) dirs.add(dir);
  }
  return [...dirs].flatMap(dir => ['--dir', dir]);
}

function assertUnprivileged(uid = typeof process.getuid === 'function' ? process.getuid() : null) {
  if (uid === 0) throw new GatewayError(78, 'GW-ROOT-FORBIDDEN', '能力网关拒绝以 root 运行；请使用专用 sameroof-gateway 用户。');
  return true;
}

// adapter token 的签发/吊销是模块级函数：服务进程和控制面（gatewayctl）共用，控制面只开 State，不构造 Gateway（构造会把 executing 的 intent 标成 failed_unknown）。
function issueAdapterToken(state, tokensDir, residentId) {
  if (!RESIDENT_ID.test(residentId)) throw new GatewayError(400, 'GW-AUTH-DENIED', 'resident_id 不合法。');
  fs.mkdirSync(tokensDir, { recursive: true, mode: 0o700 });
  const token = 'srg_' + crypto.randomBytes(32).toString('base64url');
  const file = path.join(tokensDir, residentId);
  fs.writeFileSync(file, token + '\n', { mode: 0o640 }); fs.chmodSync(file, 0o640);
  state.db.prepare("INSERT INTO adapter_tokens(resident_id,token_hash,status,created_at) VALUES(?,?,?,?) ON CONFLICT(resident_id) DO UPDATE SET token_hash=excluded.token_hash,status='active',created_at=excluded.created_at").run(residentId, sha(Buffer.from(token, 'utf8')), 'active', now());
  return { resident_id: residentId, token, file };
}
function revokeAdapterToken(state, tokensDir, residentId) {
  if (!RESIDENT_ID.test(residentId)) throw new GatewayError(400, 'GW-AUTH-DENIED', 'resident_id 不合法。');
  const changed = state.db.prepare("UPDATE adapter_tokens SET status='revoked' WHERE resident_id=? AND status='active'").run(residentId).changes;
  try { fs.unlinkSync(path.join(tokensDir, residentId)); } catch {}
  return { resident_id: residentId, revoked: changed === 1 };
}

class Gateway {
  constructor(options = {}) {
    this.houseDir = path.resolve(options.houseDir || process.env.SAMEROOF_ROOT || process.cwd());
    this.runDir = path.resolve(options.runDir || process.env.SAMEROOF_GATEWAY_RUN_DIR || '/run/sameroof-gateway');
    this.stateDir = path.resolve(options.stateDir || process.env.SAMEROOF_GATEWAY_STATE_DIR || '/var/lib/sameroof-gateway');
    this.socketPath = path.resolve(options.socketPath || process.env.SAMEROOF_GATEWAY_SOCKET || path.join(this.runDir, 'gateway.sock'));
    this.serviceTokenFile = path.resolve(options.serviceTokenFile || process.env.SAMEROOF_GATEWAY_SERVICE_TOKEN || path.join(this.stateDir, 'living-room.token'));
    this.adapterTokensDir = path.resolve(options.adapterTokensDir || path.join(this.runDir, 'tokens'));
    this.dbPath = path.resolve(options.dbPath || path.join(this.stateDir, 'gateway.db'));
    this.bwrapPath = options.bwrapPath || '/usr/bin/bwrap';
    this.bwrapProbe = options.bwrapProbe;
    this.options = options;
    this.state = new State(this.dbPath);
    const interrupted = this.state.db.prepare("SELECT request_id,resident_id,action,params_digest FROM intents WHERE status='executing'").all();
    this.state.db.prepare("UPDATE intents SET status='failed_unknown',updated_at=? WHERE status='executing'").run(now());
    for (const item of interrupted) {
      const result = resultShell('failed_unknown', 'none', { kind: 'human_action', reason: '网关上次执行中断，副作用未知；不会自动重放。' });
      result.error = { code: 'GW-FAILED-UNKNOWN', message: '执行结果未知，已禁止自动重放。' };
      this.state.db.prepare('UPDATE intents SET result_json=? WHERE request_id=?').run(JSON.stringify(result), item.request_id);
      this.state.db.prepare('INSERT OR IGNORE INTO results(request_id,result_json,created_at) VALUES(?,?,?)').run(item.request_id, JSON.stringify(result), now());
      this.state.audit('executed', { ...item, status: 'failed_unknown', details: { code: 'GW-FAILED-UNKNOWN', replayed: false } });
    }
    this.policy = loadPolicyFiles(this.houseDir, null);
    this.rooms = this.policy.rooms; this.house = this.policy.house; this.roomConfigs = this.policy.roomConfigs;
    // Startup physical clearing of retained outputs — AFTER policy is loaded, BEFORE we listen. Failure is a real error, not swallowed.
    this.startupSweep = this.sweepOutput();
    this.server = null; this.listening = false;
    this.sandboxAvailable = false; this.probeVersion = null;
    this.probeSandbox();
  }
  probeSandbox() {
    if (this.bwrapProbe === false) { this.sandboxAvailable = false; return false; }
    if (typeof this.bwrapProbe === 'function') { this.sandboxAvailable = !!this.bwrapProbe(); return this.sandboxAvailable; }
    try {
      const { spawnSync } = require('node:child_process');
      const p = spawnSync(this.bwrapPath, ['--unshare-user', '--unshare-net', ...minimalRuntimeArgs(), '/bin/true'], { stdio: 'ignore', timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
      this.sandboxAvailable = p.status === 0;
      try { this.probeVersion = fs.statSync(this.bwrapPath).mtimeMs + ':' + fs.statSync(this.bwrapPath).size; } catch {}
    } catch { this.sandboxAvailable = false; }
    return this.sandboxAvailable;
  }
  issueAdapterToken(residentId) { return issueAdapterToken(this.state, this.adapterTokensDir, residentId); }
  revokeAdapterToken(residentId) { return revokeAdapterToken(this.state, this.adapterTokensDir, residentId); }
  tokenSubject(secret) {
    if (!secret || typeof secret !== 'string') return null;
    const row = this.state.db.prepare("SELECT resident_id FROM adapter_tokens WHERE token_hash=? AND status='active'").get(sha(Buffer.from(secret, 'utf8')));
    if (row) return row.resident_id;
    const map = this.options.adapterTokens || {};
    for (const [id, value] of Object.entries(map)) if (value === secret) return id;
    return null;
  }
  knownSecrets() {
    const out = [];
    try { const value = fs.readFileSync(this.serviceTokenFile, 'utf8').trim(); if (value) out.push(value); } catch {}
    try { for (const name of fs.readdirSync(this.adapterTokensDir)) { const value = fs.readFileSync(path.join(this.adapterTokensDir, name), 'utf8').trim(); if (value) out.push(value); } } catch {}
    return out;
  }
  redactString(value) {
    let text = String(value);
    for (const secret of this.knownSecrets().sort((a, b) => b.length - a.length)) if (secret.length >= 8) text = text.split(secret).join('[已脱敏]');
    return text.replace(/(Authorization\s*:\s*Bearer\s+)[^\s]+/gi, '$1[已脱敏]').replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[已脱敏]');
  }
  redactValue(value, key = '') {
    if (/token|password|secret|api[_-]?key/i.test(key)) return '[已脱敏]';
    if (typeof value === 'string') return this.redactString(value);
    if (Array.isArray(value)) return value.map(x => this.redactValue(x));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.redactValue(v, k)]));
    return value;
  }
  verifyLockSource() {
    if (this.options.lockRequired === false) return this.policy.digest || 'unlocked';
    let lock;
    try { lock = JSON.parse(fs.readFileSync(path.join(this.houseDir, 'house.lock'), 'utf8')); } catch { throw new GatewayError(503, 'GW-POLICY-DENIED', 'house.lock 缺失或损坏，拒绝新 intent。'); }
    const files = lock?.source?.files;
    if (!files || lock.source.algorithm !== 'sha256') throw new GatewayError(503, 'GW-POLICY-DENIED', 'house.lock 没有可验证的 source。');
    const actual = ['house.yaml'];
    try { for (const entry of fs.readdirSync(path.join(this.houseDir, 'rooms'), { withFileTypes: true })) if (entry.isDirectory() && fs.existsSync(path.join(this.houseDir, 'rooms', entry.name, 'room.yaml'))) actual.push(`rooms/${entry.name}/room.yaml`); }
    catch { throw new GatewayError(503, 'GW-POLICY-DENIED', 'rooms 配置目录不可验证。'); }
    actual.sort((a, b) => a.localeCompare(b)); const locked = Object.keys(files).sort((a, b) => a.localeCompare(b));
    if (actual.length !== locked.length || actual.some((name, index) => name !== locked[index])) throw new GatewayError(503, 'GW-POLICY-DENIED', 'house.lock 的配置文件集合与磁盘不一致。');
    const records = [];
    for (const name of locked) {
      const file = path.resolve(this.houseDir, name);
      if (file !== this.houseDir && !file.startsWith(this.houseDir + path.sep)) throw new GatewayError(503, 'GW-POLICY-DENIED', 'house.lock 含越界路径。');
      let digest; try { digest = sha(fs.readFileSync(file)); } catch { throw new GatewayError(503, 'GW-POLICY-DENIED', 'house.lock 中的配置文件读不到。'); }
      if (digest !== files[name]) throw new GatewayError(503, 'GW-POLICY-DENIED', 'house.lock 与配置不一致。');
      records.push(name + '\0' + digest + '\n');
    }
    if (sha(records.join('')) !== lock.source.digest) throw new GatewayError(503, 'GW-POLICY-DENIED', 'house.lock source 摘要不一致。');
    return lock.source.digest;
  }
  ensurePolicyCurrent() {
    if (this.options.lockRequired === false) return this.policy;
    const digest = this.verifyLockSource();
    if (this.policy.digest === digest) return this.policy;
    const issues = validateHouse(this.houseDir);
    if (issues.some(x => x.severity === 'error')) throw new GatewayError(503, 'GW-POLICY-DENIED', '新配置校验失败，仍保留旧策略但拒绝新 intent。', issues);
    const candidate = loadPolicyFiles(this.houseDir, digest);
    if (this.verifyLockSource() !== digest) throw new GatewayError(503, 'GW-POLICY-DENIED', '配置在重载期间再次变化，拒绝切换策略。');
    this.probeSandbox();
    this.policy = candidate;
    this.rooms = candidate.rooms; this.house = candidate.house; this.roomConfigs = candidate.roomConfigs;
    return candidate;
  }
  // Effective permission = min(rank(house ceiling), rank(room value)); a room can tighten, never widen.
  // Unknown/missing ceiling → deny. Unknown room value → treated as deny (fail closed), audited by caller if desired.
  // Returns 'approve' | 'allow'; throws for deny. (RFC 2026-09-15-gateway-allow §2.1)
  effectivePermission(action, residentId, policy = this.policy) {
    const ceiling = policy.house.defaults?.permissions?.[action];
    const roomValue = policy.roomConfigs.get(residentId)?.permissions?.[action];
    const rank = v => (v in PERMISSION_RANK ? PERMISSION_RANK[v] : PERMISSION_RANK.deny);
    const eff = roomValue === undefined ? rank(ceiling) : Math.min(rank(ceiling), rank(roomValue));
    return Object.keys(PERMISSION_RANK).find(k => PERMISSION_RANK[k] === eff) || 'deny';
  }
  ensurePermission(action, residentId, policy = this.policy) {
    const effective = this.effectivePermission(action, residentId, policy);
    if (effective === 'deny') throw new GatewayError(403, 'GW-POLICY-DENIED', '动作未在 house/room 权限中开放。');
    return effective;
  }
  rootFor(residentId, rootId, policy = this.policy) {
    if (rootId === 'own-room') {
      const dir = policy.rooms.get(residentId); if (!dir) throw new GatewayError(403, 'GW-POLICY-DENIED', '找不到住户自己的房间。');
      return { id: rootId, path: dir, writable: true };
    }
    const mounts = policy.house.gateway?.mounts || this.options.mounts || [];
    const mount = mounts.find(x => x.id === rootId);
    if (!mount || !mount.path || !Array.isArray(mount.residents) && !mount.residents) throw new GatewayError(403, 'GW-POLICY-DENIED', '未声明的可写根。');
    const access = Array.isArray(mount.residents) ? mount.residents.includes(residentId) ? 'read-write' : null : mount.residents[residentId];
    if (!access) throw new GatewayError(403, 'GW-POLICY-DENIED', '住户不在此可写根名单中。');
    const mountPath = path.resolve(mount.path);
    let st; try { st = fs.lstatSync(mountPath); } catch { throw new GatewayError(403, 'GW-POLICY-DENIED', '挂载根不存在。'); }
    if (!st.isDirectory() || st.isSymbolicLink()) throw new GatewayError(403, 'GW-POLICY-DENIED', '挂载根必须是非链接目录。');
    if (mountPath === path.parse(mountPath).root || ['/etc', '/var', '/home', '/root', '/opt', '/srv', '/proc', '/sys', '/dev', '/usr'].includes(mountPath) || mountPath === '/run' || mountPath.startsWith('/run/') || mountPath === this.runDir || mountPath.startsWith(this.stateDir + path.sep) || (this.houseDir.startsWith(mountPath + path.sep) && mountPath !== this.houseDir)) throw new GatewayError(403, 'GW-POLICY-DENIED', '挂载根范围过宽或属于网关状态目录。');
    for (const [id, dir] of policy.rooms) if (id !== residentId && mountPath === dir) throw new GatewayError(403, 'GW-POLICY-DENIED', '不能把其他住户房间作为挂载根。');
    return { id: rootId, path: mountPath, writable: access === 'read-write' };
  }
  safeTarget(root, relative, forWrite = false, residentId = null, policy = this.policy) {
    const rel = normalizeRelative(relative);
    if (protectedPath(rel)) throw new GatewayError(403, 'GW-PATH-PROTECTED', '路径属于网关硬保护范围。');
    const segments = rel.split('/'); let cur = root.path;
    for (let i = 0; i < segments.length - 1; i++) {
      cur = path.join(cur, segments[i]);
      let st; try { st = fs.lstatSync(cur); } catch (e) { throw new GatewayError(404, 'GW-PATH-TYPE', '路径不存在。'); }
      if (st.isSymbolicLink()) throw new GatewayError(403, 'GW-PATH-SYMLINK', '路径不能经过符号链接。');
      if (!st.isDirectory()) throw new GatewayError(403, 'GW-PATH-TYPE', '路径中间段必须是目录。');
    }
    const target = path.join(root.path, rel);
    try { if (fs.lstatSync(target).isSymbolicLink()) throw new GatewayError(403, 'GW-PATH-SYMLINK', '目标不能是符号链接。'); } catch (e) { if (e instanceof GatewayError) throw e; if (!forWrite || e.code !== 'ENOENT') throw new GatewayError(404, 'GW-PATH-TYPE', '目标不存在。'); }
    const resolved = path.resolve(target); if (resolved !== root.path && !resolved.startsWith(root.path + path.sep)) throw new GatewayError(403, 'GW-PATH-OUTSIDE', '路径超出可写根。');
    if (residentId) {
      const roomsRoot = path.join(this.houseDir, 'rooms');
      if (resolved === roomsRoot || resolved.startsWith(roomsRoot + path.sep)) {
        const own = policy.rooms.get(residentId);
        if (!own || (resolved !== own && !resolved.startsWith(own + path.sep))) throw new GatewayError(403, 'GW-PATH-PROTECTED', '不能访问其他住户的房间。');
      }
    }
    return { rel, target, resolved };
  }
  openParent(root, relative, residentId, policy = this.policy) {
    const checked = this.safeTarget(root, relative, true, residentId, policy);
    const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
    const fds = [];
    const close = () => { for (const fd of fds.reverse()) try { fs.closeSync(fd); } catch {} };
    try {
      const rootFd = fs.openSync(root.path, flags); fds.push(rootFd);
      const rootReal = fs.realpathSync(`/proc/self/fd/${rootFd}`).replace(/ \(deleted\)$/, '');
      if (rootReal !== fs.realpathSync(root.path)) throw new GatewayError(403, 'GW-PATH-OUTSIDE', '可写根身份在操作前发生变化。');
      let parentFd = rootFd; const parts = checked.rel.split('/');
      for (const segment of parts.slice(0, -1)) {
        let fd; try { fd = fs.openSync(`/proc/self/fd/${parentFd}/${segment}`, flags); } catch (e) { throw new GatewayError(e.code === 'ELOOP' ? 403 : 404, e.code === 'ELOOP' ? 'GW-PATH-SYMLINK' : 'GW-PATH-TYPE', '路径中间段不是安全目录。'); }
        fds.push(fd); parentFd = fd;
        const real = fs.realpathSync(`/proc/self/fd/${fd}`).replace(/ \(deleted\)$/, '');
        if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new GatewayError(403, 'GW-PATH-OUTSIDE', '目录在操作时逃出可写根。');
      }
      return { ...checked, parentFd, leaf: parts.at(-1), targetAt: `/proc/self/fd/${parentFd}/${parts.at(-1)}`, rootReal, fds, close };
    } catch (e) { close(); throw e; }
  }
  verifyOpenedFd(fd, opened) {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new GatewayError(403, 'GW-PATH-TYPE', '只允许操作普通文件。');
    let real; try { real = fs.realpathSync(`/proc/self/fd/${fd}`).replace(/ \(deleted\)$/, ''); } catch { throw new GatewayError(403, 'GW-PATH-OUTSIDE', '打开后的文件身份无法复核。'); }
    if (real !== opened.rootReal && !real.startsWith(opened.rootReal + path.sep)) throw new GatewayError(403, 'GW-PATH-OUTSIDE', '打开后的文件逃出可写根。');
    return st;
  }
  validateIntent(body, residentId, policy = this.policy) {
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new GatewayError(400, 'GW-PARAMS-INVALID', 'intent 必须是对象。');
    const allowed = new Set(['request_id', 'resident_id', 'run_id', 'action', 'params', 'requested_ttl_seconds']);
    for (const k of Object.keys(body)) if (!allowed.has(k)) throw new GatewayError(400, 'GW-PARAMS-INVALID', '不认识字段：' + k);
    if (!REQUEST_ID.test(body.request_id || '') || body.resident_id !== residentId || !RESIDENT_ID.test(body.resident_id)) throw new GatewayError(400, 'GW-PARAMS-INVALID', 'request_id 或 resident_id 不合法。');
    if (!ACTIONS.has(body.action)) throw new GatewayError(400, 'GW-ACTION-UNKNOWN', '不认识的动作：' + body.action);
    this.ensurePermission(body.action, residentId, policy);
    if (!body.params || Array.isArray(body.params) || typeof body.params !== 'object') throw new GatewayError(400, 'GW-PARAMS-INVALID', 'params 必须是对象。');
    const ttl = body.requested_ttl_seconds === undefined ? 1800 : Number(body.requested_ttl_seconds);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 24 * 3600) throw new GatewayError(400, 'GW-PARAMS-INVALID', 'requested_ttl_seconds 超出范围。');
    const p = body.params;
    if (body.action === 'core.fs.read' || body.action === 'core.fs.write') {
      const keys = body.action === 'core.fs.read' ? new Set(['root_id', 'path', 'max_bytes']) : new Set(['root_id', 'path', 'content', 'encoding', 'mode', 'expected_sha256']);
      for (const k of Object.keys(p)) if (!keys.has(k)) throw new GatewayError(400, 'GW-PARAMS-INVALID', '不认识文件动作字段：' + k);
      if (typeof p.root_id !== 'string' || typeof p.path !== 'string') throw new GatewayError(400, 'GW-PARAMS-INVALID', '文件动作需要 root_id 与 path。');
      const root = this.rootFor(residentId, p.root_id, policy); const target = this.safeTarget(root, p.path, body.action === 'core.fs.write', residentId, policy);
      try { if (!fs.lstatSync(target.target).isFile()) throw new GatewayError(403, 'GW-PATH-TYPE', '文件动作只允许普通文件。'); }
      catch (error) { if (error instanceof GatewayError) throw error; if (body.action !== 'core.fs.write' || error.code !== 'ENOENT') throw new GatewayError(403, 'GW-PATH-TYPE', '文件动作只允许普通文件。'); }
      if (body.action === 'core.fs.write') { if (!['create', 'replace'].includes(p.mode)) throw new GatewayError(400, 'GW-PARAMS-INVALID', 'write mode 只能是 create 或 replace。'); if (typeof p.content !== 'string' || Buffer.byteLength(p.content) > MAX_CONTENT) throw new GatewayError(400, 'GW-PARAMS-INVALID', 'content 超过 1 MiB。'); if (p.encoding !== undefined && p.encoding !== 'utf8') throw new GatewayError(400, 'GW-PARAMS-INVALID', '只支持 utf8。'); }
      if (body.action === 'core.fs.read' && p.max_bytes !== undefined && (!Number.isInteger(p.max_bytes) || p.max_bytes < 1 || p.max_bytes > FS_READ_MAX)) throw new GatewayError(400, 'GW-PARAMS-INVALID', `max_bytes 必须在 1..${FS_READ_MAX}，确保结果能穿过客厅并原样进入住户上下文。`);
    } else {
      const keys = new Set(['argv', 'cwd', 'writable_root_ids', 'timeout_ms', 'env']); for (const k of Object.keys(p)) if (!keys.has(k)) throw new GatewayError(400, 'GW-PARAMS-INVALID', '不认识 exec 字段：' + k);
      if (!Array.isArray(p.argv) || !p.argv.length || p.argv.some(x => typeof x !== 'string' || !x.length || x.length > 4096)) throw new GatewayError(400, 'GW-PARAMS-INVALID', 'argv 必须是非空字符串数组。');
      if (!p.cwd || typeof p.cwd !== 'object' || typeof p.cwd.root_id !== 'string' || typeof p.cwd.path !== 'string') throw new GatewayError(400, 'GW-PARAMS-INVALID', 'exec 需要 cwd。');
      const cwdRoot = this.rootFor(residentId, p.cwd.root_id, policy); const cwd = p.cwd.path ? this.safeTarget(cwdRoot, p.cwd.path, false, residentId, policy).target : cwdRoot.path; if (!fs.statSync(cwd).isDirectory()) throw new GatewayError(400, 'GW-PARAMS-INVALID', 'cwd 必须是目录。');
      if (!Array.isArray(p.writable_root_ids) || p.writable_root_ids.some(x => typeof x !== 'string')) throw new GatewayError(400, 'GW-PARAMS-INVALID', 'writable_root_ids 必须是数组。');
      if (body.action === 'core.exec.ro' && p.writable_root_ids.length) throw new GatewayError(400, 'GW-PARAMS-INVALID', 'core.exec.ro 不接受 writable_root_ids（只读沙箱）。');
      for (const id of p.writable_root_ids) { const root = this.rootFor(residentId, id, policy); if (!root.writable) throw new GatewayError(403, 'GW-POLICY-DENIED', '可写根不是 read-write。'); }
      const timeout = p.timeout_ms === undefined ? 30000 : Number(p.timeout_ms); if (!Number.isInteger(timeout) || timeout < 1 || timeout > HARD_TIMEOUT) throw new GatewayError(400, 'GW-PARAMS-INVALID', 'timeout_ms 超出范围。');
      if (p.env !== undefined && (!p.env || typeof p.env !== 'object' || Array.isArray(p.env) || Object.keys(p.env).some(k => !['LANG', 'LC_ALL', 'TZ', 'NODE_ENV'].includes(k) || typeof p.env[k] !== 'string'))) throw new GatewayError(400, 'GW-PARAMS-INVALID', 'env 只允许有限白名单。');
    }
    return ttl;
  }
  registerIntent(body, token) {
    const residentId = this.tokenSubject(token); if (!residentId) throw new GatewayError(401, 'GW-AUTH-DENIED', '网关 token 无效。');
    const policy = this.ensurePolicyCurrent();
    const ttl = this.validateIntent(body, residentId, policy);
    if (this.options.lockRequired !== false && this.verifyLockSource() !== policy.digest) throw new GatewayError(503, 'GW-POLICY-DENIED', '配置在 intent 登记期间变化，拒绝登记。');
    const paramsDigest = jcs.digest(body.params);
    const targetDigest = this.targetDigest(body.action, body.params);
    const effective = this.effectivePermission(body.action, residentId, policy);   // validateIntent already threw for deny
    const decisionSource = effective === 'allow' ? 'policy_allow' : 'human';
    const runId = body.run_id || null;
    const old = this.state.db.prepare('SELECT * FROM intents WHERE request_id=?').get(body.request_id);
    if (old) {
      // Contract A: identity = resident + action + params + run_id + decision_source. /output binds on run_id.
      if (old.resident_id !== residentId || old.action !== body.action || old.params_digest !== paramsDigest || (old.run_id || null) !== runId || old.decision_source !== decisionSource) throw new GatewayError(409, 'GW-IDEMPOTENCY-CONFLICT', 'request_id 已绑定另一份 intent。');
      return this.intentResponse(old);
    }
    const created = now(); const expires = new Date(Date.now() + ttl * 1000).toISOString();
    if (decisionSource === 'policy_allow') {
      // Contract A: claimPolicyAllowed — rate limit before insert; one transaction inserts as executing; execution is queued, not awaited.
      this.checkAllowRate(residentId, body.action, runId);
      const row = this.claimPolicyAllowed({ requestId: body.request_id, residentId, runId, action: body.action, params: body.params, paramsDigest, targetDigest, expires, policy, created });
      this._pendingPolicy = this._pendingPolicy || new Set();
      const p = new Promise(resolve => setImmediate(resolve))
        .then(() => this.executeClaimed(row))
        .catch(error => { try { this.state.audit('executed', { request_id: row.request_id, resident_id: residentId, action: row.action, params_digest: paramsDigest, status: 'failed', details: { code: error.code || 'GW-INTERNAL', message: safeText(error.message) } }); } catch {} })
        .finally(() => this._pendingPolicy.delete(p));
      this._pendingPolicy.add(p);
      return this.intentResponse(row);
    }
    this.state.db.prepare('INSERT INTO intents(request_id,resident_id,run_id,action,params_json,params_digest,target_digest,expires_at,status,policy_digest,policy_json,decision_source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(body.request_id, residentId, runId, body.action, JSON.stringify(body.params), paramsDigest, targetDigest, expires, 'awaiting_approval', policy.digest || 'unlocked', serializePolicy(policy), 'human', created, created);
    this.state.audit('asked', { request_id: body.request_id, resident_id: residentId, action: body.action, params_digest: paramsDigest, target_digest: targetDigest, status: 'awaiting_approval' });
    return this.intentResponse(this.state.db.prepare('SELECT * FROM intents WHERE request_id=?').get(body.request_id));
  }
  // Contract A: policy-allowed claim. One transaction: insert directly as `executing` with decision_source=policy_allow. No approval row.
  claimPolicyAllowed({ requestId, residentId, runId, action, params, paramsDigest, targetDigest, expires, policy, created }) {
    const insert = this.state.db.transaction(() => {
      this.state.db.prepare('INSERT INTO intents(request_id,resident_id,run_id,action,params_json,params_digest,target_digest,expires_at,status,policy_digest,policy_json,decision_source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(requestId, residentId, runId, action, JSON.stringify(params), paramsDigest, targetDigest, expires, 'executing', policy.digest || 'unlocked', serializePolicy(policy), 'policy_allow', created, created);
      this.state.audit('asked', { request_id: requestId, resident_id: residentId, action, params_digest: paramsDigest, target_digest: targetDigest, status: 'executing', details: { decision_source: 'policy_allow' } });
      this.state.audit('decided', { request_id: requestId, approval_id: null, resident_id: residentId, action, params_digest: paramsDigest, status: 'allowed', details: { decision_source: 'policy_allow', decided_by: 'policy', policy_digest: policy.digest || 'unlocked' } });
    });
    insert();
    return this.state.db.prepare('SELECT * FROM intents WHERE request_id=?').get(requestId);
  }
  // RFC §2.6: per-resident, per-action token bucket, checked BEFORE insert. Exceed → 429, one audit row, no intent.
  checkAllowRate(residentId, action, runId) {
    const cfg = (this.policy.house.gateway && this.policy.house.gateway.allow_rate) || {};
    const perMin = Number(cfg[action] ?? (action === 'core.exec.ro' ? 20 : action === 'core.fs.read' ? 60 : 10));
    if (!Number.isFinite(perMin) || perMin <= 0) return;
    this._rate = this._rate || new Map();
    const key = residentId + '\0' + action; const nowMs = Date.now();
    const b = this._rate.get(key) || { tokens: perMin, at: nowMs };
    b.tokens = Math.min(perMin, b.tokens + (nowMs - b.at) * perMin / 60000); b.at = nowMs;
    if (b.tokens < 1) {
      this._rate.set(key, b);
      this.state.audit('rate_limited', { request_id: null, resident_id: residentId, action, params_digest: null, status: 'rejected', details: { run_id: runId, per_min: perMin } });
      const e = new GatewayError(429, 'GW-RATE-LIMITED', '政策放行动作超过速率上限。'); e.retryAfterMs = Math.ceil((1 - b.tokens) * 60000 / perMin); throw e;
    }
    b.tokens -= 1; this._rate.set(key, b);
  }
  targetDigest(action, p) {
    if (action === 'core.exec') return jcs.digest({ cwd: p.cwd, argv: p.argv, writable_root_ids: p.writable_root_ids });
    if (action === 'core.exec.ro') return jcs.digest({ action, cwd: p.cwd, argv: p.argv, writable_root_ids: [] });
    return jcs.digest({ root_id: p.root_id, path: normalizeRelative(p.path) });
  }
  intentResponse(row) {
    const p = JSON.parse(row.params_json);
    return { request_id: row.request_id, state: row.status, action: row.action, params_digest: row.params_digest, target_digest: row.target_digest, policy_digest: row.policy_digest, expires_at: row.expires_at, approval_body: { action: row.action, params: p, params_digest: row.params_digest, gateway_request_id: row.request_id, ttl_seconds: Math.max(1, Math.ceil((Date.parse(row.expires_at) - Date.now()) / 1000)) } };
  }
  // RFC §2.3b: bounded output channel for policy-allowed intents. Resident token authenticates; X-Sameroof-Run binds.
  readOutput(requestId, token, runHeader) {
    const residentId = this.tokenSubject(token); if (!residentId) throw new GatewayError(401, 'GW-AUTH-DENIED', '网关 token 无效。');
    const row = this.state.db.prepare('SELECT * FROM intents WHERE request_id=?').get(requestId);
    // 404 for: missing, other resident, human-decided (not offered), NULL run_id (foreground policy intents have no output channel),
    // missing/mismatched X-Sameroof-Run — no existence leak. The header is a required binding, so '' never matches.
    if (!row || row.resident_id !== residentId || row.decision_source !== 'policy_allow' || !row.run_id || typeof runHeader !== 'string' || runHeader === '' || runHeader !== row.run_id) throw new GatewayError(404, 'GW-OUTPUT-NOT-FOUND', '没有这条可读输出。');
    if (row.status === 'executing') throw new GatewayError(409, 'GW-OUTPUT-NOT-READY', '还在执行。');
    // Retention = the promise recorded on the row at execution time, tightened (never extended) by current policy.
    const policyTtl = Number(this.policy.house.gateway?.output_ttl_ms || 10 * 60 * 1000);
    const policyReads = Number(this.policy.house.gateway?.output_max_reads || 3);
    const rowExpires = row.output_expires_at ? Date.parse(row.output_expires_at) : (row.executed_at ? Date.parse(row.executed_at) + policyTtl : 0);
    const expiresAt = Math.min(rowExpires, row.executed_at ? Date.parse(row.executed_at) + policyTtl : rowExpires);
    const maxReads = Math.min(Number.isFinite(row.output_max_reads) && row.output_max_reads !== null ? row.output_max_reads : policyReads, policyReads);
    const maxBytes = Number(this.policy.house.gateway?.output_max_bytes || 64 * 1024);
    if (expiresAt <= Date.now()) { this.clearOutput(requestId, 'expired'); throw new GatewayError(410, 'GW-OUTPUT-EXPIRED', '输出已过期。'); }
    // atomic read-count increment: concurrent GETs cannot exceed maxReads
    const claimed = this.state.db.prepare('UPDATE intents SET output_reads=output_reads+1 WHERE request_id=? AND output_json IS NOT NULL AND output_reads<? RETURNING output_json, output_reads').get(requestId, maxReads);
    if (!claimed) throw new GatewayError(410, 'GW-OUTPUT-CONSUMED', '输出已读满或已清除。');
    let full; try { full = JSON.parse(claimed.output_json); } catch { this.clearOutput(requestId, 'corrupt'); throw new GatewayError(410, 'GW-OUTPUT-CONSUMED', '输出不可解析。'); }
    const remaining = maxReads - claimed.output_reads;
    if (remaining <= 0) this.clearOutput(requestId, 'reads_exhausted');
    const origBytes = {}; if (full.details) { if (typeof full.details.stdout_raw === 'string') full.details.stdout = full.details.stdout_raw; if (typeof full.details.stderr_raw === 'string') full.details.stderr = full.details.stderr_raw; if (Number.isFinite(full.details.stdout_raw_bytes)) origBytes.stdout = full.details.stdout_raw_bytes; if (Number.isFinite(full.details.stderr_raw_bytes)) origBytes.stderr = full.details.stderr_raw_bytes; delete full.details.stdout_raw; delete full.details.stderr_raw; delete full.details.stdout_raw_bytes; delete full.details.stderr_raw_bytes; }
    // whole-response cap: cut the three content fields proportionally, then verify total
    const out = { request_id: requestId, run_id: row.run_id, action: row.action, state: row.status, decision: { source: 'policy_allow', policy_digest: row.policy_digest }, reads_remaining: remaining, truncated: false, total_bytes: {}, result: full };
    const fields = ['stdout', 'stderr', 'content'].filter(k => full.details && typeof full.details[k] === 'string');
    const overhead = Buffer.byteLength(JSON.stringify({ ...out, result: { ...full, details: { ...(full.details || {}), ...Object.fromEntries(fields.map(k => [k, ''])) } } }));
    let budget = Math.max(0, maxBytes - overhead);
    const sizes = Object.fromEntries(fields.map(k => [k, Buffer.byteLength(full.details[k])]));
    const total = Object.values(sizes).reduce((a, b) => a + b, 0);
    if (total > budget) {
      out.truncated = true;
      for (const k of fields) { out.total_bytes[k] = origBytes[k] ?? sizes[k]; const share = Math.floor(budget * sizes[k] / Math.max(1, total)); full.details[k] = Buffer.from(full.details[k]).subarray(0, share).toString('utf8'); }
    }
    for (const k of fields) if (origBytes[k] !== undefined && origBytes[k] > sizes[k]) { out.truncated = true; out.total_bytes[k] = origBytes[k]; }   // already cut at execShell
    // JSON escaping (\n → 2 bytes, etc.) isn't in the byte count above: converge on the serialised size.
    for (let guard = 0; guard < 8 && Buffer.byteLength(JSON.stringify(out)) > maxBytes; guard++) {
      const k = fields.reduce((a, b) => (Buffer.byteLength(full.details[a] || '') >= Buffer.byteLength(full.details[b] || '') ? a : b), fields[0]);
      if (!k || !full.details[k]) break;
      const over = Buffer.byteLength(JSON.stringify(out)) - maxBytes; const cur = Buffer.from(full.details[k]);
      full.details[k] = cur.subarray(0, Math.max(0, cur.length - over - 16)).toString('utf8'); out.truncated = true; if (out.total_bytes[k] === undefined) out.total_bytes[k] = origBytes[k] ?? sizes[k];
    }
    this.state.audit('output_read', { request_id: requestId, resident_id: residentId, action: row.action, params_digest: row.params_digest, status: row.status, details: { run_id: row.run_id, bytes: Buffer.byteLength(JSON.stringify(out)), truncated: out.truncated, reads_remaining: remaining } });
    return out;
  }
  clearOutput(requestId, reason) {
    const r = this.state.db.prepare('UPDATE intents SET output_json=NULL WHERE request_id=? AND output_json IS NOT NULL').run(requestId);
    if (r.changes) this.state.audit('output_cleared', { request_id: requestId, resident_id: null, action: null, params_digest: null, status: reason, details: {} });
  }
  // physical clearing for rows nobody read (periodic sweep + startup)
  sweepOutput() {
    const ttlMs = Number(this.policy.house.gateway?.output_ttl_ms || 10 * 60 * 1000);
    const nowIso = now(), cutoff = new Date(Date.now() - ttlMs).toISOString();
    // expired by the row's own recorded promise OR by current (possibly tighter) policy; reads exhausted by row cap
    const rows = this.state.db.prepare("SELECT request_id FROM intents WHERE output_json IS NOT NULL AND (output_expires_at<=? OR (executed_at IS NOT NULL AND executed_at<=?) OR (output_max_reads IS NOT NULL AND output_reads>=output_max_reads))").all(nowIso, cutoff);
    for (const r of rows) this.clearOutput(r.request_id, 'expired');
    return rows.length;
  }
  getIntent(requestId, token) {
    const residentId = this.tokenSubject(token); if (!residentId) throw new GatewayError(401, 'GW-AUTH-DENIED', '网关 token 无效。');
    const row = this.state.db.prepare('SELECT * FROM intents WHERE request_id=?').get(requestId);
    if (!row || row.resident_id !== residentId) throw new GatewayError(404, 'GW-INTENT-NOT-FOUND', '找不到这条 intent。');
    let result = null; try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch {}
    return { request_id: row.request_id, resident_id: row.resident_id, run_id: row.run_id, action: row.action, state: row.status, params_digest: row.params_digest, target_digest: row.target_digest, policy_digest: row.policy_digest, created_at: row.created_at, updated_at: row.updated_at, expires_at: row.expires_at, ...(result ? { result } : {}) };
  }
  // Contract A: `execute` = claimHumanApproved + executeClaimed. Kept as the public name for the approval path (living-room poll loop calls it).
  async execute(requestId, approval) {
    const row = this.claimHumanApproved(requestId, approval);
    return this.executeClaimed(row, approval);
  }
  claimHumanApproved(requestId, approval) {
    const row = this.state.db.prepare('SELECT * FROM intents WHERE request_id=?').get(requestId);
    if (!row) throw new GatewayError(409, 'GW-APPROVAL-MISMATCH', 'intent 不存在。');
    if (row.status !== 'awaiting_approval') throw new GatewayError(409, row.status === 'executing' ? 'GW-APPROVAL-USED' : 'GW-APPROVAL-MISMATCH', 'intent 已不是待审批状态。');
    if (!approval || approval.decision !== 'allowed' || approval.single_use !== true || typeof approval.approval_id !== 'string' || !approval.approval_id || approval.gateway_request_id !== requestId || approval.resident_id !== row.resident_id || approval.action !== row.action || approval.params_digest !== row.params_digest) throw new GatewayError(409, 'GW-APPROVAL-MISMATCH', '审批与 intent 绑定不一致。');
    if (!approval.expires_at || !Number.isFinite(Date.parse(approval.expires_at)) || Date.parse(row.expires_at) <= Date.now() || Date.parse(approval.expires_at) <= Date.now()) { this.state.db.prepare('UPDATE intents SET status=?,updated_at=? WHERE request_id=?').run('expired', now(), requestId); this.state.audit('decided', { request_id: requestId, approval_id: approval.approval_id, resident_id: row.resident_id, action: row.action, params_digest: row.params_digest, status: 'expired' }); throw new GatewayError(409, 'GW-APPROVAL-EXPIRED', '审批已过期或没有有效期限。'); }
    const claim = this.state.db.transaction(() => {
      const known = this.state.db.prepare('SELECT * FROM approvals WHERE approval_id=?').get(approval.approval_id);
      if (known && (known.consumed || known.request_id !== requestId || known.resident_id !== row.resident_id || known.action !== row.action || known.params_digest !== row.params_digest)) throw new GatewayError(409, 'GW-APPROVAL-USED', 'approval_id 已使用或绑定到另一份 intent。');
      if (!known) this.state.db.prepare('INSERT INTO approvals(approval_id,request_id,resident_id,action,params_digest,decision,remember,decided_by,decided_at,expires_at,single_use,consumed) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)').run(approval.approval_id, requestId, row.resident_id, row.action, row.params_digest, approval.decision, approval.remember || 'once', approval.decided_by || null, approval.decided_at || now(), approval.expires_at || null, 1);
      const changed = this.state.db.prepare('UPDATE intents SET status=?,approval_id=?,approval_expires_at=?,updated_at=? WHERE request_id=? AND status=?').run('executing', approval.approval_id, approval.expires_at || null, now(), requestId, 'awaiting_approval');
      if (changed.changes !== 1) throw new GatewayError(409, 'GW-APPROVAL-USED', 'intent 已被其他执行者认领。');
      this.state.db.prepare('UPDATE approvals SET consumed=1 WHERE approval_id=? AND consumed=0').run(approval.approval_id);
    });
    claim();
    this.state.audit('decided', { request_id: requestId, approval_id: approval.approval_id, resident_id: row.resident_id, action: row.action, params_digest: row.params_digest, status: 'allowed', details: { decision_source: 'human', remember: approval.remember || 'once', decided_by: approval.decided_by || null } });
    return this.state.db.prepare('SELECT * FROM intents WHERE request_id=?').get(requestId);
  }
  // Contract A: shared execution body. `row.status` must already be `executing` (claimed by either path). `approval` is null on the policy path.
  async executeClaimed(row, approval = null) {
    const requestId = row.request_id;
    const params = JSON.parse(row.params_json);
    let policy; try { policy = deserializePolicy(row.policy_json); } catch { throw new GatewayError(503, 'GW-POLICY-DENIED', 'intent 没有可验证的登记时策略快照。'); }
    if (row.status !== 'executing') throw new GatewayError(409, 'GW-APPROVAL-MISMATCH', 'intent 未被认领。');
    const exec = row.action === 'core.exec.ro' ? { ...params, writable_root_ids: [] } : params;   // core.exec.ro: read-only sandbox by construction (§2.2)
    let result;
    try { result = row.action === 'core.fs.read' ? await this.execRead(row.resident_id, params, policy) : row.action === 'core.fs.write' ? await this.execWrite(row.resident_id, params, policy) : await this.execShell(row.resident_id, exec, policy); }
    catch (error) {
      result = error.result || resultShell(error.code === 'GW-TIMEOUT' ? 'timed_out' : 'failed', error.executor || 'none', error.next || { kind: 'human_action', reason: safeText(error.message) });
      result.error = { code: error.code || 'GW-INTERNAL', message: safeText(error.message) };
    }
    result = this.redactValue(result);
    result.coverage.requested = result.coverage.requested || [row.action];
    const persisted = JSON.parse(JSON.stringify(result));
    if (row.action === 'core.fs.read' && persisted.summary) persisted.summary = '[content omitted]';
    if (persisted.details) {
      if (Object.hasOwn(persisted.details, 'content')) persisted.details.content = '[content omitted]';
      if (Object.hasOwn(persisted.details, 'content_base64')) persisted.details.content_base64 = '[content omitted]';
      if (Object.hasOwn(persisted.details, 'stdout')) persisted.details.stdout = '[output omitted]';
      if (Object.hasOwn(persisted.details, 'stderr')) persisted.details.stderr = '[output omitted]';
      delete persisted.details.stdout_raw; delete persisted.details.stderr_raw; delete persisted.details.stdout_raw_bytes; delete persisted.details.stderr_raw_bytes;
    }
    const executedAt = now();
    // /output (RFC §2.3b): the redacted FULL result is kept only for policy-allowed intents, only until ttl/reads (see readOutput/sweepOutput).
    const outputJson = row.decision_source === 'policy_allow' ? JSON.stringify(result) : null;
    const capTtl = Number(this.policy.house.gateway?.output_ttl_ms || 10 * 60 * 1000), capReads = Number(this.policy.house.gateway?.output_max_reads || 3);
    const outputExpires = outputJson ? new Date(Date.parse(executedAt) + capTtl).toISOString() : null;
    this.state.db.prepare('UPDATE intents SET status=?,result_json=?,output_json=?,output_expires_at=?,output_max_reads=?,executed_at=?,updated_at=? WHERE request_id=?').run(result.status, JSON.stringify(persisted), outputJson, outputExpires, outputJson ? capReads : null, executedAt, executedAt, requestId);
    this.state.audit('executed', { request_id: requestId, approval_id: approval ? approval.approval_id : null, resident_id: row.resident_id, action: row.action, params_digest: row.params_digest, status: result.status, details: { coverage: result.coverage, next: result.next } });
    this.state.db.prepare('INSERT INTO results(request_id,result_json,created_at) VALUES(?,?,?) ON CONFLICT(request_id) DO UPDATE SET result_json=excluded.result_json').run(requestId, JSON.stringify(result), now());
    try { const delivery = await this.deliverResult(row, approval, result); this.markDelivered(requestId, delivery?.message_id); }
    catch (error) { result.delivery_error = 'GW-RESULT-DELIVERY-FAILED'; this.state.audit('delivery_failed', { request_id: requestId, resident_id: row.resident_id, action: row.action, status: result.status }); }
    return result;
  }
  async execRead(residentId, p, policy = this.policy) {
    const root = this.rootFor(residentId, p.root_id, policy); const t = this.openParent(root, p.path, residentId, policy); let fd;
    try {
      if (this.options.pathRaceHook) this.options.pathRaceHook({ action: 'read', opened: t });
      try { fd = fs.openSync(t.targetAt, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW); } catch (e) { throw new GatewayError(e.code === 'ELOOP' ? 403 : 404, e.code === 'ELOOP' ? 'GW-PATH-SYMLINK' : 'GW-PATH-TYPE', '目标不是安全普通文件。'); }
      const st = this.verifyOpenedFd(fd, t); const max = p.max_bytes || FS_READ_MAX; const size = Math.min(st.size, max + 1); const buf = Buffer.alloc(size); const read = fs.readSync(fd, buf, 0, size, 0); const value = buf.subarray(0, read); const clipped = value.length > max ? value.subarray(0, max) : value; const truncated = st.size > max;
      let encoding = 'utf8'; let content;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(clipped); }
      catch { encoding = 'base64'; content = clipped.toString('base64'); }
      const label = encoding === 'utf8' ? 'UTF-8' : 'base64';
      const out = resultShell('succeeded', 'path-rules'); out.coverage.requested = [`${p.root_id}:${t.rel}`]; out.coverage.completed = out.coverage.requested.slice(); out.summary = `文件 ${t.rel}（${label}${truncated ? '，已截断' : ''}）：\n${content}`; out.details = { bytes: clipped.length, truncated, encoding, ...(encoding === 'utf8' ? { content } : { content_base64: content }) }; return out;
    } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} t.close(); }
  }
  async execWrite(residentId, p, policy = this.policy) {
    const root = this.rootFor(residentId, p.root_id, policy); if (!root.writable) throw new GatewayError(403, 'GW-POLICY-DENIED', '此根只读。'); const t = this.openParent(root, p.path, residentId, policy); let fd; let created = false;
    try {
      if (this.options.pathRaceHook) this.options.pathRaceHook({ action: 'write', opened: t });
      const flags = p.mode === 'create' ? fs.constants.O_WRONLY | fs.constants.O_NONBLOCK | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW : fs.constants.O_RDWR | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW;
      try { fd = fs.openSync(t.targetAt, flags, 0o600); created = p.mode === 'create'; } catch (e) { if (e.code === 'ELOOP') throw new GatewayError(403, 'GW-PATH-SYMLINK', '目标不能是符号链接。'); throw new GatewayError(409, 'GW-PATH-TYPE', p.mode === 'create' ? 'create 要求目标不存在。' : 'replace 要求目标已存在。'); }
      this.verifyOpenedFd(fd, t);
      if (p.expected_sha256 && !created) { const st = fs.fstatSync(fd); const old = Buffer.alloc(st.size); fs.readSync(fd, old, 0, st.size, 0); if (sha(old) !== p.expected_sha256) throw new GatewayError(409, 'GW-PATH-TYPE', 'expected_sha256 不匹配。'); }
      const data = Buffer.from(p.content, 'utf8'); if (!created) fs.ftruncateSync(fd, 0); fs.writeSync(fd, data, 0, data.length, 0); fs.fsyncSync(fd); this.verifyOpenedFd(fd, t);
      const out = resultShell('succeeded', 'path-rules'); out.coverage.requested = [`${p.root_id}:${t.rel}`]; out.coverage.completed = out.coverage.requested.slice(); out.details = { bytes_written: data.length, sha256: sha(data) }; return out;
    } catch (e) { if (created && fd !== undefined) try { fs.unlinkSync(t.targetAt); } catch {} throw e; }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} t.close(); }
  }
  async execShell(residentId, p, policy = this.policy) {
    if (process.env.SAMEROOF_GATEWAY_FAULT_BEFORE_SPAWN) {   // test-only fault injection window (matrix #23); no effect unless the env var is set
      fs.writeFileSync(process.env.SAMEROOF_GATEWAY_FAULT_BEFORE_SPAWN, 'about-to-spawn\n');
      await new Promise(r => setTimeout(r, 30000));
    }
    if (!this.sandboxAvailable || !this.probeSandbox()) { const e = new GatewayError(503, 'GW-SANDBOX-UNAVAILABLE', 'bwrap 探针失败，拒绝执行。'); e.result = resultShell('denied', 'none', { kind: 'human_action', reason: 'sandbox_unavailable' }); e.result.coverage.sandbox = 'unavailable'; e.executor = 'none'; throw e; }
    const cwdRoot = this.rootFor(residentId, p.cwd.root_id, policy); const cwd = p.cwd.path ? this.safeTarget(cwdRoot, p.cwd.path, false, residentId, policy).target : cwdRoot.path; const argv = p.argv.slice();
    const roots = new Map([[cwdRoot.path, { ...cwdRoot, writable: false }]]);
    for (const id of p.writable_root_ids || []) { const root = this.rootFor(residentId, id, policy); roots.set(root.path, { ...root, writable: true }); }
    const mountedRoots = [...roots.values()].sort((a, b) => a.path.length - b.path.length);
    const hidden = this.hiddenHostPaths(mountedRoots.map(x => x.path), residentId, policy);
    const args = ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-net', '--unshare-ipc', '--unshare-pid', '--unshare-uts', ...minimalRuntimeArgs(), ...destinationDirs([...mountedRoots.map(x => x.path), ...hidden.map(x => x.path)])];
    for (const root of mountedRoots) args.push(root.writable ? '--bind' : '--ro-bind', root.path, root.path);
    for (const item of hidden) {
      if (item.directory) args.push('--tmpfs', item.path, '--remount-ro', item.path);
      else args.push('--ro-bind', '/dev/null', item.path);
    }
    args.push('--chdir', cwd, '--clearenv'); for (const [k, v] of Object.entries(p.env || {})) args.push('--setenv', k, v); args.push('--', ...argv);
    const timeout = p.timeout_ms || 30000; const child = spawn(this.bwrapPath, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } }); let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), outTr = false, errTr = false;
    const append = (old, chunk, which) => { const room = MAX_OUTPUT - old.length; if (room <= 0) { if (which === 'out') outTr = true; else errTr = true; return old; } if (chunk.length > room) { if (which === 'out') outTr = true; else errTr = true; return Buffer.concat([old, chunk.subarray(0, room)]); } return Buffer.concat([old, chunk]); };
    child.stdout.on('data', c => { stdout = append(stdout, c, 'out'); }); child.stderr.on('data', c => { stderr = append(stderr, c, 'err'); });
    let timer; const code = await new Promise(resolve => {
      let settled = false; let timedOut = false; let killTimer;
      timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 500); }, Math.min(timeout, HARD_TIMEOUT));
      child.on('error', error => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); resolve({ spawnError: error }); });
      child.on('close', (c, s) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); resolve(timedOut ? { timedOut: true, code: c, signal: s } : { code: c, signal: s }); });
    });
    if (code.spawnError) { const e = new GatewayError(503, 'GW-SANDBOX-UNAVAILABLE', 'bwrap 启动失败，拒绝执行。'); e.result = resultShell('denied', 'none', { kind: 'human_action', reason: 'sandbox_start_failed' }); e.result.coverage.sandbox = 'unavailable'; e.executor = 'none'; throw e; }
    if (code.timedOut) { const e = new GatewayError(408, 'GW-TIMEOUT', '命令超时。'); e.result = resultShell('timed_out', 'bwrap', { kind: 'human_action', reason: 'timeout' }); e.executor = 'bwrap'; throw e; }
    const out = resultShell(code.code === 0 ? 'succeeded' : 'failed', 'bwrap'); out.coverage.host_filesystem = 'minimal'; out.coverage.hidden_paths = hidden.length; out.coverage.stdout_truncated = outTr; out.coverage.stderr_truncated = errTr; out.coverage.requested = [`exec:${safeText(argv.join(' '), 200)}`]; out.coverage.completed = code.code === 0 ? out.coverage.requested.slice() : []; const rawOut = this.redactString(stdout.toString('utf8')), rawErr = this.redactString(stderr.toString('utf8')); const rawCap = Number(this.policy.house.gateway?.output_max_bytes || 64 * 1024); out.details = { exit_code: code.code, signal: code.signal || null, stdout: safeText(rawOut), stderr: safeText(rawErr), stdout_raw: Buffer.from(rawOut).subarray(0, rawCap).toString('utf8'), stderr_raw: Buffer.from(rawErr).subarray(0, rawCap).toString('utf8'), stdout_raw_bytes: Buffer.byteLength(rawOut), stderr_raw_bytes: Buffer.byteLength(rawErr) }; if (/EPERM|permission denied/i.test(out.details.stderr)) out.next = { kind: 'request_writable_root', reason: '沙箱内权限不足，只能扩一条明确可写根后重试。' }; return out;
  }
  hiddenHostPaths(rootPaths, residentId, policy = this.policy) {
    const candidates = [path.join(this.houseDir, 'state'), path.join(this.houseDir, '.sameroof'), this.runDir, this.stateDir, this.serviceTokenFile, this.adapterTokensDir, '/var/lib/sameroof-gateway', '/var/lib/sameroof-broker', '/var/lib/sameroof-living-room', ...(this.options.sensitivePaths || [])];
    for (const [id, dir] of policy.rooms) if (id !== residentId) candidates.push(dir);
    for (const rootPath of rootPaths) {
      const queue = [{ dir: rootPath, rel: '' }]; let seen = 0;
      while (queue.length) {
        const current = queue.pop(); let entries;
        try { entries = fs.readdirSync(current.dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          if (++seen > 250000) throw new GatewayError(503, 'GW-SANDBOX-DENIED', '可写根过大，无法完整证明硬保护路径。');
          const rel = current.rel ? current.rel + '/' + entry.name : entry.name; const absolute = path.join(current.dir, entry.name);
          if (protectedPath(rel)) { candidates.push(absolute); continue; }
          if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push({ dir: absolute, rel });
        }
      }
    }
    const inside = candidate => rootPaths.some(root => candidate !== root && candidate.startsWith(root + path.sep));
    const values = [];
    for (const candidate of [...new Set(candidates.map(x => path.resolve(x)))]) {
      if (!inside(candidate)) continue;
      let st; try { st = fs.lstatSync(candidate); } catch { continue; }
      values.push({ path: candidate, directory: st.isDirectory() });
    }
    values.sort((a, b) => a.path.length - b.path.length);
    return values.filter((item, index) => !values.slice(0, index).some(parent => parent.directory && item.path.startsWith(parent.path + path.sep)));
  }
  async deliverResult(row, approval, result) {
    if (this.options.resultClient) { const r = result && result.details ? { ...result, details: { ...result.details } } : result; if (r && r.details) { delete r.details.stdout_raw; delete r.details.stderr_raw; delete r.details.stdout_raw_bytes; delete r.details.stderr_raw_bytes; } return this.options.resultClient({ row, approval, result: r }); }
    let token; try { const st = fs.statSync(this.serviceTokenFile); if ((st.mode & 0o077) !== 0) throw new Error('unsafe token mode'); token = fs.readFileSync(this.serviceTokenFile, 'utf8').trim(); } catch { throw new GatewayError(503, 'GW-RESULT-DELIVERY-FAILED', '客厅 service token 不可用。'); }
    const decision = approval ? { source: 'human', approval_id: approval.approval_id } : { source: 'policy_allow', policy_digest: row.policy_digest };
    if (result && result.details) { result = { ...result, details: { ...result.details } }; delete result.details.stdout_raw; delete result.details.stderr_raw; delete result.details.stdout_raw_bytes; delete result.details.stderr_raw_bytes; }
    let payload = { request_id: row.request_id, approval_id: approval ? approval.approval_id : null, decision, run_id: row.run_id || null, resident_id: row.resident_id, action: row.action, ...result, summary: result.summary || (result.status === 'succeeded' ? '动作已完成。' : '动作未完成。') };
    let body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 60 * 1024) {
      payload = { request_id: row.request_id, approval_id: approval ? approval.approval_id : null, decision, run_id: row.run_id || null, resident_id: row.resident_id, action: row.action, status: 'failed', summary: '结果超过客厅传输上限，已终止重试；请缩小请求。', error: { code: 'GW-RESULT-TOO-LARGE', message: '结果无法安全传输。' }, coverage: result.coverage, next: { kind: 'human_action', reason: '缩小结果后发起新的 intent。' } };
      body = JSON.stringify(payload);
    }
    const options = this.options.livingRoomSocketPath ? { socketPath: this.options.livingRoomSocketPath, path: '/internal/gateway/results', method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } } : { hostname: '127.0.0.1', port: this.options.livingRoomPort, path: '/internal/gateway/results', method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } };
    return new Promise((resolve, reject) => { const req = http.request(options, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('living room ' + res.statusCode)); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } }); }); req.on('error', reject); req.end(body); });
  }
  async retryUndelivered() {
    const rows = this.state.db.prepare('SELECT i.*,r.result_json AS delivery_result_json FROM results r JOIN intents i ON i.request_id=r.request_id WHERE r.delivered_at IS NULL ORDER BY r.created_at LIMIT 50').all();
    let delivered = 0;
    for (const row of rows) {
      try { const response = await this.deliverResult(row, { approval_id: row.approval_id }, JSON.parse(row.delivery_result_json)); this.markDelivered(row.request_id, response?.message_id); delivered++; }
      catch { this.state.audit('delivery_failed', { request_id: row.request_id, resident_id: row.resident_id, action: row.action, status: row.status }); }
    }
    return { pending: rows.length - delivered, delivered };
  }
  markDelivered(requestId, messageId = null) {
    this.state.db.prepare('UPDATE results SET message_id=?,delivered_at=?,result_json=? WHERE request_id=?').run(messageId || null, now(), JSON.stringify({ delivered: true }), requestId);
  }
  expirePending() {
    try { this.sweepOutput(); } catch {}
    const expired = this.state.db.prepare("SELECT * FROM intents WHERE status='awaiting_approval' AND expires_at<=?").all(now());
    const update = this.state.db.prepare("UPDATE intents SET status='expired',updated_at=? WHERE request_id=? AND status='awaiting_approval'");
    for (const row of expired) if (update.run(now(), row.request_id).changes) this.state.audit('decided', { request_id: row.request_id, resident_id: row.resident_id, action: row.action, params_digest: row.params_digest, status: 'expired', details: { decision_source: 'timeout' } });
    return expired.length;
  }
  async pollApprovalResults() {
    let token; try { const st = fs.statSync(this.serviceTokenFile); if ((st.mode & 0o077) !== 0) throw new Error('unsafe token mode'); token = fs.readFileSync(this.serviceTokenFile, 'utf8').trim(); } catch { throw new GatewayError(503, 'GW-APPROVAL-SERVICE-UNAVAILABLE', '客厅 service token 不可用。'); }
    const cursor = this.state.db.prepare('SELECT value FROM cursors WHERE name=?').get('approval')?.value || 0;
    const options = this.options.livingRoomSocketPath ? { socketPath: this.options.livingRoomSocketPath, path: `/internal/gateway/approval-results?after_seq=${cursor}&limit=100`, headers: { authorization: 'Bearer ' + token } } : { hostname: '127.0.0.1', port: this.options.livingRoomPort, path: `/internal/gateway/approval-results?after_seq=${cursor}&limit=100`, headers: { authorization: 'Bearer ' + token } };
    const body = await new Promise((resolve, reject) => { const req = http.request(options, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { if (res.statusCode !== 200) return reject(new GatewayError(503, 'GW-APPROVAL-SERVICE-UNAVAILABLE', '客厅决定流不可用。')); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('bad approval response')); } }); }); req.on('error', reject); req.end(); });
    for (const item of body.items || []) {
      if (item.decision === 'allowed') {
        try { await this.execute(item.gateway_request_id, item); }
        catch (e) {
          const row = this.state.db.prepare('SELECT * FROM intents WHERE request_id=?').get(item.gateway_request_id);
          if (row && row.status === 'awaiting_approval') {
            this.state.db.prepare("UPDATE intents SET status='denied',approval_id=?,updated_at=? WHERE request_id=? AND status='awaiting_approval'").run(item.approval_id || null, now(), item.gateway_request_id);
            this.state.audit('decided', { request_id: item.gateway_request_id, approval_id: item.approval_id, resident_id: row.resident_id, action: row.action, params_digest: row.params_digest, status: 'denied', details: { code: e.code || 'GW-APPROVAL-MISMATCH', decision_source: 'invalid_approval' } });
          }
          this.state.audit('approval_rejected', { request_id: item.gateway_request_id, approval_id: item.approval_id, status: 'denied', details: { code: e.code } });
        }
      } else {
        const row = this.state.db.prepare('SELECT * FROM intents WHERE request_id=?').get(item.gateway_request_id);
        if (row && row.status === 'awaiting_approval' && item.resident_id === row.resident_id && item.action === row.action && item.params_digest === row.params_digest) {
          this.state.db.prepare('INSERT OR IGNORE INTO approvals(approval_id,request_id,resident_id,action,params_digest,decision,remember,decided_by,decided_at,expires_at,single_use,consumed) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)').run(item.approval_id, item.gateway_request_id, item.resident_id, item.action, item.params_digest, 'denied', item.remember || 'once', item.decided_by || null, item.decided_at || now(), item.expires_at || null, item.single_use ? 1 : 0);
          this.state.db.prepare('UPDATE intents SET status=?,approval_id=?,updated_at=? WHERE request_id=? AND status=?').run('denied', item.approval_id, now(), item.gateway_request_id, 'awaiting_approval');
          this.state.audit('decided', { request_id: item.gateway_request_id, approval_id: item.approval_id, resident_id: row.resident_id, action: row.action, params_digest: row.params_digest, status: 'denied', details: { remember: item.remember || 'once' } });
          const result = resultShell('denied', 'none', { kind: 'none' }); result.error = { code: 'GW-POLICY-DENIED', message: '户主拒绝了这次动作。' };
          this.state.db.prepare('UPDATE intents SET result_json=? WHERE request_id=?').run(JSON.stringify(result), item.gateway_request_id);
          this.state.db.prepare('INSERT INTO results(request_id,result_json,created_at) VALUES(?,?,?) ON CONFLICT(request_id) DO NOTHING').run(item.gateway_request_id, JSON.stringify(result), now());
          try { const delivery = await this.deliverResult(row, item, result); this.markDelivered(item.gateway_request_id, delivery?.message_id); } catch { this.state.audit('delivery_failed', { request_id: item.gateway_request_id, resident_id: row.resident_id, action: row.action, status: 'denied' }); }
        } else this.state.audit('approval_rejected', { request_id: item.gateway_request_id, approval_id: item.approval_id, status: 'denied', details: { code: 'GW-APPROVAL-MISMATCH' } });
      }
      this.state.db.prepare('INSERT INTO cursors(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run('approval', item.seq);
    }
    return { processed: (body.items || []).length, next_seq: body.next_seq ?? cursor };
  }
  listen() {
    if (this.server) return Promise.resolve(this.server.address());
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    const bindPath = path.join(path.dirname(this.socketPath), '.' + path.basename(this.socketPath) + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex'));
    this.server = http.createServer(async (req, res) => { try {
      if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, sandbox: this.sandboxAvailable });
      if (!req.url.startsWith('/v1/intents')) throw new GatewayError(404, 'GW-ROUTE-NOT-FOUND', '网关路由不存在。');
      const get = /^\/v1\/intents\/(req_[A-Za-z0-9_-]+)$/.exec(req.url);
      if (req.method === 'GET' && get) return json(res, 200, this.getIntent(get[1], bearer(req)));
      const getOut = /^\/v1\/intents\/(req_[A-Za-z0-9_-]+)\/output$/.exec(req.url);
      if (req.method === 'GET' && getOut) return json(res, 200, this.readOutput(getOut[1], bearer(req), req.headers['x-sameroof-run']));
      if (req.method !== 'POST' || req.url !== '/v1/intents') throw new GatewayError(404, 'GW-ROUTE-NOT-FOUND', '只开放 POST /v1/intents 与 GET /v1/intents/:id。');
      const body = await readJson(req);
      if (String(req.headers['idempotency-key'] || '') !== body.request_id) throw new GatewayError(400, 'GW-IDEMPOTENCY-CONFLICT', 'Idempotency-Key 必须等于 request_id。');
      return json(res, 200, this.registerIntent(body, bearer(req)));
    } catch (e) { errorJson(res, e); } });
    return new Promise((resolve, reject) => {
      this.server.once('error', error => { try { fs.unlinkSync(bindPath); } catch {} reject(error); });
      this.server.listen(bindPath, () => {
        try { fs.chmodSync(bindPath, this.options.socketMode || 0o660); fs.renameSync(bindPath, this.socketPath); const st = fs.statSync(this.socketPath); this.socketIdentity = `${st.dev}:${st.ino}`; }
        catch (error) { this.server.close(); try { fs.unlinkSync(bindPath); } catch {} return reject(error); }
        this.listening = true; resolve({ socketPath: this.socketPath });
      });
    });
  }
  startApprovalLoop(intervalMs = 1000) {
    if (this.pollTimer) return;
    const tick = async () => { if (this.polling) return; this.polling = true; try { this.expirePending(); await this.retryUndelivered(); await this.pollApprovalResults(); } catch {} finally { this.polling = false; } };
    this.pollTimer = setInterval(tick, Math.max(250, intervalMs)); this.pollTimer.unref(); tick();
  }
  stopApprovalLoop() { if (this.pollTimer) clearInterval(this.pollTimer); this.pollTimer = null; }
  async close() { this.stopApprovalLoop(); if (this._pendingPolicy && this._pendingPolicy.size) await Promise.race([Promise.allSettled([...this._pendingPolicy]), new Promise(r => setTimeout(r, 5000))]); return new Promise(resolve => { if (!this.server) { this.state.close(); return resolve(); } this.server.close(() => { try { const st = fs.statSync(this.socketPath); if (`${st.dev}:${st.ino}` === this.socketIdentity) fs.unlinkSync(this.socketPath); } catch {} this.state.close(); resolve(); }); }); }
}

function createGateway(options = {}) { return new Gateway(options); }
if (require.main === module) { try { assertUnprivileged(); const gateway = createGateway({ livingRoomSocketPath: process.env.SAMEROOF_LIVING_ROOM_SOCKET || undefined, livingRoomPort: Number(process.env.SAMEROOF_LIVING_ROOM_PORT || process.env.SAMEROOF_PORT || 8790) }); gateway.listen().then(() => { gateway.startApprovalLoop(); console.log('sameroof gateway listening ' + gateway.socketPath); }).catch(error => { console.error(error.code || error); process.exitCode = 1; }); } catch (error) { console.error(error.code || error); process.exitCode = error.status || 1; } }
module.exports = { Gateway, GatewayError, State, issueAdapterToken, revokeAdapterToken, createGateway, normalizeRelative, protectedPath, resultShell, assertUnprivileged, minimalRuntimeArgs, FS_READ_MAX };
