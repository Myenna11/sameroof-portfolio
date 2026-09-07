// 同屋 · 配额 · 读 broker 账本（只读）：凭证 key、住户 token 预算、今日用量。只在后端用，key 只进请求头。
'use strict';
const fs = require('fs');
let Database = null; try { Database = require('better-sqlite3'); } catch {}

function dbPath(env = process.env) { return env.SAMEROOF_BROKER_DB || '/var/lib/sameroof-broker/broker.db'; }
function open(env) {
  const file = dbPath(env);
  if (!Database) throw new Error('better-sqlite3 没装，读不了 broker 账本');
  if (!fs.existsSync(file)) throw new Error(`broker 账本不存在（${file}）`);
  return new Database(file, { readonly: true, fileMustExist: true });
}
function withDb(env, fn) { let db = null; try { db = open(env); return fn(db); } finally { if (db) db.close(); } }
// 某家 provider 的活跃真凭证：{ alias, base_url, api_key }（api_key 只给 provider 模块拼请求头）
function credentialFor(env, provider, alias) {
  return withDb(env, db => {
    const rows = db.prepare("SELECT alias, provider, base_url, api_key FROM credentials WHERE provider=? AND active=1 AND base_url NOT LIKE 'http://127.0.0.1%' ORDER BY alias").all(provider);
    return (alias && rows.find(r => r.alias === alias)) || rows[0] || null;
  });
}
// 住户在 broker 里的活跃 token 预算 + 今日（dayStartIso 起）账本
function budgets(env, residentIds, dayStartIso) {
  return withDb(env, db => residentIds.map(id => {
    const tokens = db.prepare("SELECT id, max_requests, used_requests, max_tokens, used_tokens, expires_at, credential_aliases FROM tokens WHERE resident_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at DESC").all(id, new Date().toISOString());   // 到期的 token 不算预算
    const today = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(actual_tokens),0) AS tokens FROM ledger WHERE resident_id=? AND ts>=? AND status IN ('complete','mock_complete')").get(id, dayStartIso);
    return { resident_id: id, tokens, today };
  }));
}
module.exports = { dbPath, credentialFor, budgets };
