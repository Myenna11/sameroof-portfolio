#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RESIDENT_ID = /^resident_[a-z0-9][a-z0-9_-]{2,95}$/;

class TokenError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class TokenStore {
  constructor(options = {}) {
    this.file = path.resolve(options.file || process.env.SAMEROOF_LIVING_ROOM_TOKENS || path.join(os.homedir(), '.sameroof', 'run', 'living-room-tokens.json'));
    this.lockFile = this.file + '.lock';
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(this.file), 0o700); } catch {}
    this.tokens = {};
    this.fingerprint = null;
    this.reload(true);
  }

  fingerprintNow() {
    try {
      const stat = fs.statSync(this.file);
      return [stat.dev, stat.ino, stat.size, stat.mtimeMs].join(':');
    } catch { return null; }
  }

  read() {
    if (!fs.existsSync(this.file)) return {};
    let value;
    try { value = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) { throw new TokenError('LR-TOKEN-FILE-INVALID', '客厅 token 文件损坏：' + error.message); }
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new TokenError('LR-TOKEN-FILE-INVALID', '客厅 token 文件必须是 resident_id 到 token/null 的对象。');
    for (const [residentId, token] of Object.entries(value)) {
      if (!RESIDENT_ID.test(residentId)) throw new TokenError('LR-TOKEN-RESIDENT-INVALID', 'token 文件含非法 resident id：' + residentId);
      if (token !== null && (typeof token !== 'string' || token.length < 32)) throw new TokenError('LR-TOKEN-VALUE-INVALID', residentId + ' 的 token 太短或类型错误。');
    }
    return value;
  }

  reload(force = false) {
    const fingerprint = this.fingerprintNow();
    if (!force && fingerprint === this.fingerprint) return false;
    this.tokens = this.read();
    this.fingerprint = fingerprint;
    return true;
  }

  authenticate(secret) {
    this.reload();
    if (typeof secret !== 'string' || secret.length < 32) return null;
    for (const [residentId, token] of Object.entries(this.tokens)) {
      if (!token || token.length !== secret.length) continue;
      const a = Buffer.from(token);
      const b = Buffer.from(secret);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return residentId;
    }
    return null;
  }

  acquireLock() {
    try { return fs.openSync(this.lockFile, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const age = Date.now() - fs.statSync(this.lockFile).mtimeMs;
        if (age > 30000) {
          fs.unlinkSync(this.lockFile);
          return fs.openSync(this.lockFile, 'wx', 0o600);
        }
      } catch {}
      throw new TokenError('LR-TOKEN-LOCKED', '另一个 token 命令正在运行，请稍后再试。');
    }
  }

  write(value) {
    const temporary = this.file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
    try {
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.file);
      fs.chmodSync(this.file, 0o600);
    } finally {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
    }
  }

  mutate(fn) {
    const fd = this.acquireLock();
    try {
      const value = this.read();
      const result = fn(value);
      this.write(value);
      this.tokens = value;
      this.fingerprint = this.fingerprintNow();
      return result;
    } finally {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(this.lockFile); } catch {}
    }
  }

  ensure(residentIds) {
    const wanted = [...new Set(residentIds)];
    for (const id of wanted) if (!RESIDENT_ID.test(id)) throw new TokenError('LR-TOKEN-RESIDENT-INVALID', '非法 resident id：' + id);
    const missing = wanted.filter(id => !Object.hasOwn(this.tokens, id));
    if (!missing.length) return [];
    return this.mutate(value => missing.map(residentId => {
      if (Object.hasOwn(value, residentId)) return null;
      const token = crypto.randomBytes(32).toString('base64url');
      value[residentId] = token;
      return { resident_id: residentId, token, created: true };
    }).filter(Boolean));
  }

  issue(residentId) {
    if (!RESIDENT_ID.test(residentId)) throw new TokenError('LR-TOKEN-RESIDENT-INVALID', '非法 resident id：' + residentId);
    return this.mutate(value => {
      if (typeof value[residentId] === 'string') return { resident_id: residentId, token: value[residentId], created: false };
      const token = crypto.randomBytes(32).toString('base64url');
      value[residentId] = token;
      return { resident_id: residentId, token, created: true };
    });
  }

  rotate(residentId) {
    if (!RESIDENT_ID.test(residentId)) throw new TokenError('LR-TOKEN-RESIDENT-INVALID', '非法 resident id：' + residentId);
    return this.mutate(value => {
      const token = crypto.randomBytes(32).toString('base64url');
      value[residentId] = token;
      return { resident_id: residentId, token, rotated: true };
    });
  }

  revoke(residentId) {
    if (!RESIDENT_ID.test(residentId)) throw new TokenError('LR-TOKEN-RESIDENT-INVALID', '非法 resident id：' + residentId);
    return this.mutate(value => {
      const existed = typeof value[residentId] === 'string';
      value[residentId] = null;
      return { resident_id: residentId, revoked: existed };
    });
  }

  list() {
    this.reload();
    return Object.entries(this.tokens).map(([resident_id, token]) => ({
      resident_id,
      status: token ? 'active' : 'revoked',
      fingerprint: token ? crypto.createHash('sha256').update(token).digest('hex').slice(0, 12) : null
    })).sort((a, b) => a.resident_id.localeCompare(b.resident_id));
  }
}

let singleton;
function defaultStore() {
  if (!singleton) singleton = new TokenStore();
  return singleton;
}
function issue(residentId) { return defaultStore().issue(residentId); }
function rotate(residentId) { return defaultStore().rotate(residentId); }
function revoke(residentId) { return defaultStore().revoke(residentId); }

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

if (require.main === module) {
  try {
    const [command, residentId] = process.argv.slice(2);
    const store = defaultStore();
    if (command === 'issue') print(store.issue(residentId));
    else if (command === 'rotate') print(store.rotate(residentId));
    else if (command === 'revoke') print(store.revoke(residentId));
    else if (command === 'list') print(store.list());
    else {
      console.error('用法：tokens.js issue|rotate|revoke <resident_id>；tokens.js list');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error((error.code || 'LR-TOKEN-ERROR') + ': ' + error.message);
    process.exitCode = 1;
  }
}

module.exports = { TokenStore, TokenError, issue, rotate, revoke };
