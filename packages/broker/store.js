'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const SAFE_RESIDENT = /^resident_[a-z0-9][a-z0-9_-]{2,95}$/;

function nowIso() {
  return new Date().toISOString();
}

function hashToken(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function list(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',').map(x => x.trim()).filter(Boolean);
  return fallback;
}

function parseRow(row) {
  if (!row) return null;
  const out = { ...row };
  for (const key of ['credential_aliases', 'models', 'purposes']) out[key] = JSON.parse(out[key]);
  return out;
}

class BrokerError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class BrokerStore {
  constructor(options = {}) {
    this.home = path.resolve(options.home || process.env.SAMEROOF_HOME || path.join(os.homedir(), '.sameroof'));
    this.runDir = path.resolve(options.runDir || process.env.SAMEROOF_RUN_DIR || path.join(this.home, 'run'));
    this.stateDir = path.resolve(options.stateDir || process.env.SAMEROOF_STATE_DIR || path.join(this.home, 'state'));
    this.tokenDir = path.resolve(options.tokenDir || process.env.SAMEROOF_TOKEN_DIR || path.join(this.runDir, 'tokens'));
    for (const [dir, mode] of [[this.home, 0o700], [this.stateDir, 0o700], [this.runDir, 0o750], [this.tokenDir, 0o700]]) {
      fs.mkdirSync(dir, { recursive: true, mode });
      try { fs.chmodSync(dir, mode); } catch {}
    }
    this.dbPath = path.resolve(options.dbPath || path.join(this.stateDir, 'broker.db'));
    this.db = new Database(this.dbPath);
    try { fs.chmodSync(this.dbPath, 0o600); } catch {}
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credentials(
        alias TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        auth_header TEXT NOT NULL DEFAULT 'authorization',
        auth_scheme TEXT NOT NULL DEFAULT 'Bearer',
        active INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        rotated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS tokens(
        id TEXT PRIMARY KEY,
        token_hash TEXT UNIQUE NOT NULL,
        resident_id TEXT NOT NULL,
        credential_aliases TEXT NOT NULL,
        models TEXT NOT NULL,
        purposes TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        max_requests INTEGER,
        max_tokens INTEGER,
        used_requests INTEGER NOT NULL DEFAULT 0,
        used_tokens INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        reason TEXT,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS ledger(
        request_id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        resident_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        credential_alias TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        purpose TEXT NOT NULL,
        reserve_tokens INTEGER NOT NULL,
        actual_tokens INTEGER,
        estimated INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        http_status INTEGER,
        latency_ms INTEGER,
        FOREIGN KEY(token_id) REFERENCES tokens(id)
      );
      CREATE INDEX IF NOT EXISTS ledger_resident_ts ON ledger(resident_id, ts);
    `);
    const credentialColumns = this.db.prepare('PRAGMA table_info(credentials)').all().map(row => row.name);
    if (!credentialColumns.includes('path_style')) this.db.exec("ALTER TABLE credentials ADD COLUMN path_style TEXT NOT NULL DEFAULT 'auto'");
  }

  close() {
    this.db.close();
  }

  addCredential(input) {
    const alias = String(input.alias || '');
    const provider = String(input.provider || '');
    const baseUrl = String(input.baseUrl || '');
    const apiKey = String(input.apiKey || '');
    const authHeader = String(input.authHeader || 'authorization').toLowerCase();
    const authScheme = input.authScheme === undefined ? (authHeader === 'x-api-key' ? '' : 'Bearer') : String(input.authScheme);
    const pathStyle = String(input.pathStyle || 'auto');
    if (!SAFE_NAME.test(alias)) throw new BrokerError(400, 'CRED-ALIAS-INVALID', '凭证别名格式不合法。');
    if (!SAFE_NAME.test(provider)) throw new BrokerError(400, 'CRED-PROVIDER-INVALID', 'provider 格式不合法。');
    if (!apiKey) throw new BrokerError(400, 'CRED-KEY-EMPTY', '真凭证不能为空。');
    if (/[\r\n]/.test(apiKey) || /[\r\n]/.test(authScheme)) throw new BrokerError(400, 'CRED-HEADER-INJECTION', '凭证和认证 scheme 不能包含换行。');
    if (!['authorization', 'x-api-key'].includes(authHeader)) throw new BrokerError(400, 'CRED-HEADER-INVALID', '只允许 authorization 或 x-api-key 注入。');
    if (!['auto', 'openai', 'bare'].includes(pathStyle)) throw new BrokerError(400, 'CRED-PATH-STYLE-INVALID', 'path_style 只能是 auto、openai 或 bare。');
    let url;
    try { url = new URL(baseUrl); } catch { throw new BrokerError(400, 'CRED-URL-INVALID', 'base_url 不是合法 URL。'); }
    if (url.username || url.password || url.hash) throw new BrokerError(400, 'CRED-URL-SECRET', 'base_url 不能含用户名、密码或片段。');
    const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
      throw new BrokerError(400, 'CRED-URL-INSECURE', '上游必须使用 HTTPS；只有本机测试地址允许 HTTP。');
    }
    const ts = nowIso();
    try {
      this.db.prepare(`INSERT INTO credentials(alias,provider,base_url,api_key,auth_header,auth_scheme,path_style,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(alias, provider, url.toString().replace(/\/$/, ''), apiKey, authHeader, authScheme, pathStyle, ts);
    } catch (error) {
      if (String(error.code).includes('CONSTRAINT')) throw new BrokerError(409, 'CRED-ALIAS-EXISTS', '凭证别名已存在；轮换请用 rotate。');
      throw error;
    }
    return { alias, provider, base_url: url.toString().replace(/\/$/, ''), path_style: pathStyle, active: true, version: 1, created_at: ts };
  }

  listCredentials() {
    return this.db.prepare('SELECT alias,provider,base_url,auth_header,path_style,active,version,created_at,rotated_at FROM credentials ORDER BY alias').all()
      .map(row => ({ ...row, active: Boolean(row.active) }));
  }

  setCredentialPathStyle(alias, pathStyle) {
    if (!['auto', 'openai', 'bare'].includes(pathStyle)) throw new BrokerError(400, 'CRED-PATH-STYLE-INVALID', 'path_style 只能是 auto、openai 或 bare。');
    const result = this.db.prepare('UPDATE credentials SET path_style=? WHERE alias=?').run(pathStyle, alias);
    if (!result.changes) throw new BrokerError(404, 'CRED-NOT-FOUND', '没有这个凭证别名。');
    return { alias, path_style: pathStyle };
  }

  rotateCredential(alias, apiKey) {
    if (!apiKey) throw new BrokerError(400, 'CRED-KEY-EMPTY', '新凭证不能为空。');
    const ts = nowIso();
    const result = this.db.prepare('UPDATE credentials SET api_key=?, active=1, version=version+1, rotated_at=? WHERE alias=?').run(apiKey, ts, alias);
    if (!result.changes) throw new BrokerError(404, 'CRED-NOT-FOUND', '没有这个凭证别名。');
    return this.db.prepare('SELECT alias,provider,active,version,rotated_at FROM credentials WHERE alias=?').get(alias);
  }

  revokeCredential(alias) {
    const result = this.db.prepare('UPDATE credentials SET active=0 WHERE alias=?').run(alias);
    if (!result.changes) throw new BrokerError(404, 'CRED-NOT-FOUND', '没有这个凭证别名。');
    return { alias, active: false };
  }

  issueToken(input) {
    const residentId = String(input.residentId || '');
    if (!SAFE_RESIDENT.test(residentId)) throw new BrokerError(400, 'TOKEN-RESIDENT-INVALID', 'resident id 格式不合法。');
    const credentials = [...new Set(list(input.credentials))];
    const models = [...new Set(list(input.models))];
    const purposes = [...new Set(list(input.purposes, ['interactive']))];
    if (!credentials.length) throw new BrokerError(400, 'TOKEN-CREDENTIALS-EMPTY', 'token 至少绑定一个凭证别名。');
    if (!models.length) throw new BrokerError(400, 'TOKEN-MODELS-EMPTY', 'token 至少绑定一个 model。');
    for (const alias of credentials) {
      const credential = this.db.prepare('SELECT active FROM credentials WHERE alias=?').get(alias);
      if (!credential || !credential.active) throw new BrokerError(400, 'TOKEN-CREDENTIAL-INVALID', '凭证“' + alias + '”不存在或已吊销。');
    }
    const ttlSeconds = Math.max(60, Math.min(Number(input.ttlSeconds || 43200), 604800));
    const maxRequests = input.maxRequests == null ? null : Number(input.maxRequests);
    const maxTokens = input.maxTokens == null ? null : Number(input.maxTokens);
    if (maxRequests != null && (!Number.isSafeInteger(maxRequests) || maxRequests < 0)) throw new BrokerError(400, 'TOKEN-BUDGET-INVALID', 'max_requests 必须是非负整数。');
    if (maxTokens != null && (!Number.isSafeInteger(maxTokens) || maxTokens < 0)) throw new BrokerError(400, 'TOKEN-BUDGET-INVALID', 'max_tokens 必须是非负整数。');
    const id = 'tok_' + crypto.randomBytes(8).toString('hex');
    const secret = 'sr_' + crypto.randomBytes(32).toString('base64url');
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.db.prepare(`INSERT INTO tokens(id,token_hash,resident_id,credential_aliases,models,purposes,expires_at,max_requests,max_tokens,reason,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, hashToken(secret), residentId, JSON.stringify(credentials), JSON.stringify(models), JSON.stringify(purposes), expiresAt, maxRequests, maxTokens, input.reason || null, createdAt);
    let tokenFile = null;
    let replacedTokenId = null;
    if (input.writeFile !== false) {
      tokenFile = path.join(this.tokenDir, residentId);
      if (fs.existsSync(tokenFile) && !input.replaceFile) {
        this.db.prepare('DELETE FROM tokens WHERE id=?').run(id);
        throw new BrokerError(409, 'TOKEN-FILE-EXISTS', '该住户已有 token 文件；如确认替换，请显式使用 --replace。');
      }
      let previousHash = null;
      if (fs.existsSync(tokenFile)) {
        previousHash = hashToken(fs.readFileSync(tokenFile, 'utf8').trim());
        replacedTokenId = this.db.prepare("SELECT id FROM tokens WHERE token_hash=? AND status!='revoked'").get(previousHash)?.id || null;
      }
      const temporary = tokenFile + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
      try {
        fs.writeFileSync(temporary, secret + '\n', { mode: 0o600, flag: 'wx' });
        fs.chmodSync(temporary, 0o600);
        if (input.replaceFile) fs.renameSync(temporary, tokenFile);
        else { fs.linkSync(temporary, tokenFile); fs.unlinkSync(temporary); }
        if (previousHash) this.db.prepare("UPDATE tokens SET status='revoked', revoked_at=? WHERE token_hash=? AND id!=?").run(nowIso(), previousHash, id);
      } catch (error) {
        try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
        this.db.prepare('DELETE FROM tokens WHERE id=?').run(id);
        if (error.code === 'EEXIST') throw new BrokerError(409, 'TOKEN-FILE-EXISTS', '该住户已有 token 文件；如确认替换，请显式使用 --replace。');
        throw error;
      }
    }
    return { id, secret, resident_id: residentId, credential_aliases: credentials, models, purposes, expires_at: expiresAt, max_requests: maxRequests, max_tokens: maxTokens, token_file: tokenFile, replaced_token_id: replacedTokenId };
  }

  revokeToken(id) {
    const ts = nowIso();
    const result = this.db.prepare("UPDATE tokens SET status='revoked', revoked_at=? WHERE id=? AND status!='revoked'").run(ts, id);
    if (!result.changes) throw new BrokerError(404, 'TOKEN-NOT-FOUND', '没有这个可吊销的 token。');
    return { id, status: 'revoked', revoked_at: ts };
  }

  setTokenStatus(id, status) {
    if (!['active', 'throttled', 'quarantined'].includes(status)) throw new BrokerError(400, 'TOKEN-STATUS-INVALID', 'token 状态不合法。');
    const result = this.db.prepare('UPDATE tokens SET status=? WHERE id=?').run(status, id);
    if (!result.changes) throw new BrokerError(404, 'TOKEN-NOT-FOUND', '没有这个 token。');
    return { id, status };
  }

  authenticate(secret) {
    if (typeof secret !== 'string' || !secret.startsWith('sr_')) throw new BrokerError(401, 'TOKEN-INVALID', '住户 token 无效或已过期。');
    const row = parseRow(this.db.prepare('SELECT * FROM tokens WHERE token_hash=?').get(hashToken(secret)));
    if (!row || row.status === 'revoked' || Date.parse(row.expires_at) <= Date.now()) throw new BrokerError(401, 'TOKEN-INVALID', '住户 token 无效或已过期。');
    if (row.status === 'quarantined') throw new BrokerError(403, 'TOKEN-QUARANTINED', '这个住户 token 已隔离，等户主检查。');
    if (row.status === 'throttled') throw new BrokerError(429, 'TOKEN-THROTTLED', '这个住户 token 正在限流。');
    return row;
  }

  reserve(secret, input) {
    const reserveTokens = Math.ceil(Number(input.reserveTokens || 0));
    if (!Number.isSafeInteger(reserveTokens) || reserveTokens < 0) throw new BrokerError(400, 'BUDGET-RESERVE-INVALID', 'token 预留量必须是非负整数。');
    return this.db.transaction(() => {
      const token = this.authenticate(secret);
      const credentialAlias = input.credential || (token.credential_aliases.length === 1 ? token.credential_aliases[0] : null);
      if (!credentialAlias) throw new BrokerError(400, 'CRED-SELECT-REQUIRED', 'token 绑定了多个凭证，请明确选择。');
      if (!token.credential_aliases.includes(credentialAlias)) throw new BrokerError(403, 'CRED-NOT-ALLOWED', '这个 token 不能使用该凭证。');
      const credential = this.db.prepare('SELECT * FROM credentials WHERE alias=? AND active=1').get(credentialAlias);
      if (!credential) throw new BrokerError(403, 'CRED-INACTIVE', '凭证不存在或已吊销。');
      const purpose = String(input.purpose || 'interactive');
      if (!token.purposes.includes('*') && !token.purposes.includes(purpose)) throw new BrokerError(403, 'PURPOSE-NOT-ALLOWED', '这个 token 不能用于 ' + purpose + '。');
      const model = String(input.model || '');
      if (!model) throw new BrokerError(400, 'MODEL-REQUIRED', '请求必须明确 model。');
      if (!token.models.includes('*') && !token.models.includes(model)) throw new BrokerError(403, 'MODEL-NOT-ALLOWED', '这个 token 不能使用 model ' + model + '。');
      if (token.max_requests != null && token.used_requests >= token.max_requests) throw new BrokerError(429, 'BUDGET-REQUESTS-EXCEEDED', '这个 token 的请求额度已用完。');
      if (token.max_tokens != null && token.used_tokens + reserveTokens > token.max_tokens) throw new BrokerError(429, 'BUDGET-TOKENS-EXCEEDED', '这个 token 的 token 额度不足。');
      const requestId = 'req_' + crypto.randomBytes(10).toString('hex');
      this.db.prepare('UPDATE tokens SET used_requests=used_requests+1, used_tokens=used_tokens+? WHERE id=?').run(reserveTokens, token.id);
      this.db.prepare(`INSERT INTO ledger(request_id,ts,resident_id,token_id,credential_alias,provider,model,purpose,reserve_tokens,status)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(requestId, nowIso(), token.resident_id, token.id, credentialAlias, credential.provider, model, purpose, reserveTokens, 'reserved');
      return { requestId, token, credential, reserveTokens, purpose, model };
    })();
  }

  settle(requestId, input = {}) {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM ledger WHERE request_id=?').get(requestId);
      if (!row) throw new BrokerError(404, 'LEDGER-NOT-FOUND', '找不到请求预留记录。');
      if (row.status !== 'reserved') return row;
      const actual = input.actualTokens == null ? row.reserve_tokens : Math.max(0, Math.ceil(Number(input.actualTokens)));
      const adjustment = actual - row.reserve_tokens;
      this.db.prepare('UPDATE tokens SET used_tokens=MAX(0, used_tokens+?) WHERE id=?').run(adjustment, row.token_id);
      this.db.prepare(`UPDATE ledger SET actual_tokens=?, estimated=?, status=?, http_status=?, latency_ms=? WHERE request_id=?`)
        .run(actual, input.estimated === false ? 0 : 1, String(input.status || 'complete'), input.httpStatus || null, input.latencyMs || null, requestId);
      return this.db.prepare('SELECT * FROM ledger WHERE request_id=?').get(requestId);
    })();
  }

  listLedger(limit = 50) {
    return this.db.prepare('SELECT * FROM ledger ORDER BY ts DESC LIMIT ?').all(Math.max(1, Math.min(Number(limit), 500)));
  }

  listTokens() {
    return this.db.prepare('SELECT id,resident_id,credential_aliases,models,purposes,expires_at,max_requests,max_tokens,used_requests,used_tokens,status,reason,created_at,revoked_at FROM tokens ORDER BY created_at DESC').all().map(parseRow);
  }
}

module.exports = { BrokerStore, BrokerError, hashToken };
