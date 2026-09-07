// Claude（Claude Code OAuth）：读本机 ~/.claude/.credentials.json 的 access token，调 api.anthropic.com/api/oauth/usage。
// 只读：不刷新、不写回。取数方法参考 token-monitor 的 claude/limits.js；成功响应形状按它写（本机没有活登录态，没能拿真响应对账——见 README）。
'use strict';
const path = require('path');
const { getJson, readJsonFile, window, QuotaError } = require('../lib');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

function credentialsPath(env = process.env) { return env.SAMEROOF_QUOTA_CLAUDE_CREDENTIALS || path.join(env.HOME || '/root', '.claude', '.credentials.json'); }
function readCredentials(env) {
  const file = credentialsPath(env);
  const raw = readJsonFile(file);
  const o = raw && (raw.claudeAiOauth || raw.oauth);
  if (!o || !o.accessToken) throw new QuotaError(`本机没有 Claude Code 登录态（${file}）`, 'QUOTA-NOT-LOGGED-IN');
  if (o.expiresAt != null && Number(o.expiresAt) <= Date.now()) throw new QuotaError(`Claude Code 登录态已过期（${o.expiresAt ? new Date(Number(o.expiresAt)).toISOString() : '没有过期时间'}），在这台机器上 claude /login 一次`, 'QUOTA-EXPIRED');
  return { accessToken: String(o.accessToken), plan: [o.subscriptionType, o.rateLimitTier].filter(Boolean).join(' · ') };
}
const LABELS = { five_hour: '5 小时窗', seven_day: '7 天窗' };
function parse(json) {
  if (!json || typeof json !== 'object') throw new QuotaError('usage 响应不是对象');
  const windows = [];
  for (const [key, val] of Object.entries(json)) {
    if (!val || typeof val !== 'object') continue;
    const used = val.utilization ?? val.used_percent ?? val.usedPercent ?? val.percent;
    if (used == null) continue;
    const label = LABELS[key] || (key.startsWith('seven_day_') ? `7 天窗 · ${key.slice(10)}` : key);
    const w = window(label, used, { resetAt: val.resets_at ?? val.resetsAt }); if (w) windows.push(w);
  }
  if (!windows.length) throw new QuotaError('usage 响应里没有认得的窗口');
  return windows;
}
async function fetchQuota(ctx = {}) {
  const cred = readCredentials(ctx.env);
  const r = await getJson(USAGE_URL, { authorization: `Bearer ${cred.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' }, ctx);
  if (r.status === 401 || r.status === 403) throw new QuotaError(`Claude 登录态被拒（${r.status}）：${(r.json && (r.json.error?.message || r.json.message)) || r.text}`, 'QUOTA-EXPIRED');
  if (r.status !== 200) throw new QuotaError(`api.anthropic.com 回了 ${r.status}：${r.text}`);
  return { status: 'ok', windows: parse(r.json), message: cred.plan ? `方案 ${cred.plan}` : undefined };
}
module.exports = { id: 'claude', label: 'Claude', fetch: fetchQuota, parse, credentialsPath };
