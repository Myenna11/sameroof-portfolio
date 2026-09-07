// Codex（ChatGPT OAuth）：读 codex CLI 的 auth.json，调 chatgpt.com/backend-api/wham/usage。只读：token 过期就报过期，不去刷新（刷新会轮换 refresh token，和 codex 自己抢写）。
// 取数方法参考 token-monitor 的 codex/limits.js；401 响应形状是本机真拿到的，成功形状按参考实现写。
'use strict';
const path = require('path');
const { getJson, readJsonFile, window, secondsLabel, QuotaError } = require('../lib');
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function authPath(env = process.env) { return env.SAMEROOF_QUOTA_CODEX_AUTH || path.join(env.HOME || '/root', '.codex', 'auth.json'); }
function jwtExp(token) { try { const p = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); return p.exp ? p.exp * 1000 : null; } catch { return null; } }
function readAuth(env) {
  const file = authPath(env);
  const a = readJsonFile(file);
  const t = a && a.tokens;
  if (!t || !t.access_token) throw new QuotaError(`本机没有 Codex 登录态（${file}）`, 'QUOTA-NOT-LOGGED-IN');
  const exp = jwtExp(t.access_token);
  if (exp && exp <= Date.now()) throw new QuotaError(`Codex 登录态已过期（${new Date(exp).toISOString()}），在这台机器上跑一次 codex 让它自己刷新`, 'QUOTA-EXPIRED');
  return { accessToken: t.access_token, accountId: t.account_id || null };
}
function parse(json) {
  if (!json || typeof json !== 'object') throw new QuotaError('usage 响应不是对象');
  const rl = json.rate_limit || json.rateLimit || {};
  const windows = [];
  for (const [key, fallback] of [['primary_window', '主窗口'], ['secondary_window', '次窗口']]) {
    const w = rl[key] || rl[key.replace(/_w/, 'W').replace('_', '')];
    if (!w || typeof w !== 'object') continue;
    const label = secondsLabel(w.limit_window_seconds ?? w.limitWindowSeconds) || fallback;
    const out = window(label, w.used_percent ?? w.usedPercent, { resetAt: w.resets_at ?? w.resetsAt ?? w.reset_at }); if (out) windows.push(out);
  }
  if (!windows.length) throw new QuotaError('usage 响应里没有认得的窗口');
  return { windows, plan: json.plan_type || json.planType || null };
}
async function fetchQuota(ctx = {}) {
  const auth = readAuth(ctx.env);
  const headers = { authorization: `Bearer ${auth.accessToken}` }; if (auth.accountId) headers['chatgpt-account-id'] = auth.accountId;
  const r = await getJson(USAGE_URL, headers, ctx);
  if (r.status === 401 || r.status === 403) throw new QuotaError(`Codex 登录态被拒（${r.status}）：${(r.json && (r.json.detail?.message || r.json.error?.message)) || r.text}`, 'QUOTA-EXPIRED');
  if (r.status !== 200) throw new QuotaError(`chatgpt.com 回了 ${r.status}：${r.text}`);
  const p = parse(r.json);
  return { status: 'ok', windows: p.windows, message: p.plan ? `方案 ${p.plan}` : undefined };
}
module.exports = { id: 'codex', label: 'Codex', fetch: fetchQuota, parse, authPath };
