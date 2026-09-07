// Kimi Code（会员，pi 的 kimi-coding OAuth）：读 pi 的 auth.json，调 api.kimi.com/coding/v1/usages。只读：过期就报过期，实现员下次醒来 pi 自己会刷。
// 取数方法参考 token-usage 的 kimiQuery 和 token-monitor 的 kimi/limits.js；401 形状是本机真拿到的，成功形状按参考实现写。
'use strict';
const path = require('path');
const { getJson, readJsonFile, num, window, QuotaError } = require('../lib');
const USAGE_URL = 'https://api.kimi.com/coding/v1/usages';

function authPath(env = process.env) { return env.SAMEROOF_QUOTA_PI_AUTH || path.join(env.HOME || '/root', '.pi', 'agent', 'auth.json'); }
function readAuth(env) {
  const file = authPath(env);
  const a = readJsonFile(file);
  const k = a && a['kimi-coding'];
  if (!k || !k.access) throw new QuotaError(`本机没有 Kimi Code 登录态（${file} 里没有 kimi-coding）`, 'QUOTA-NOT-LOGGED-IN');
  if (k.expires && Number(k.expires) <= Date.now()) throw new QuotaError(`Kimi Code 登录态已过期（${new Date(Number(k.expires)).toISOString()}），实现员下次醒来 pi 会自己刷新`, 'QUOTA-EXPIRED');
  return { accessToken: String(k.access) };
}
// {limit, remaining, used, resetTime} → 用了百分之几
function usedPercentOf(d) {
  if (!d || typeof d !== 'object') return null;
  const limit = num(d.limit), used = num(d.used), remaining = num(d.remaining);
  if (limit && used != null) return used / limit * 100;
  if (limit && remaining != null) return (limit - remaining) / limit * 100;
  return num(d.usedPercent ?? d.used_percent ?? d.percentage);
}
const UNIT_MIN = { MINUTE: 1, TIME_UNIT_MINUTE: 1, HOUR: 60, TIME_UNIT_HOUR: 60, DAY: 1440, TIME_UNIT_DAY: 1440, WEEK: 10080, TIME_UNIT_WEEK: 10080 };
function windowLabel(w) {
  const d = num(w && (w.duration ?? w.size ?? w.value)); const u = String((w && (w.timeUnit ?? w.time_unit ?? w.unit)) || '').toUpperCase();
  if (d == null || !UNIT_MIN[u]) return '限速窗';
  const mins = d * UNIT_MIN[u];
  if (mins % 10080 === 0) return `${mins / 10080} 周窗`; if (mins % 1440 === 0) return `${mins / 1440} 天窗`; if (mins % 60 === 0) return `${mins / 60} 小时窗`; return `${mins} 分钟窗`;
}
function parse(json) {
  if (!json || typeof json !== 'object') throw new QuotaError('usages 响应不是对象');
  const windows = [];
  const top = json.usage;
  const w0 = top && window('周额度', usedPercentOf(top), { resetAt: top.resetTime ?? top.reset_time ?? top.resetAt, detail: top.limit != null && top.used != null ? `${top.used} / ${top.limit}` : undefined });
  if (w0) windows.push(w0);
  for (const entry of Array.isArray(json.limits) ? json.limits : []) {
    const d = entry && (entry.detail || entry.usage || entry.quota);
    const w = window(windowLabel(entry && (entry.window || entry.period)), usedPercentOf(d), { resetAt: d && (d.resetTime ?? d.reset_time ?? d.resetAt), detail: d && d.limit != null && d.used != null ? `${d.used} / ${d.limit}` : undefined });
    if (w) windows.push(w);
  }
  if (!windows.length) throw new QuotaError('usages 响应里没有认得的窗口');
  return windows;
}
async function fetchQuota(ctx = {}) {
  const auth = readAuth(ctx.env);
  const r = await getJson(USAGE_URL, { authorization: `Bearer ${auth.accessToken}` }, ctx);
  if (r.status === 401 || r.status === 403) { const msg = r.json && r.json.details && r.json.details[0] && r.json.details[0].debug && r.json.details[0].debug.localizedMessage && r.json.details[0].debug.localizedMessage.message; throw new QuotaError(`Kimi 登录态被拒（${r.status}）：${msg || (r.json && r.json.code) || r.text}`, 'QUOTA-EXPIRED'); }
  if (r.status !== 200) throw new QuotaError(`api.kimi.com 回了 ${r.status}：${r.text}`);
  return { status: 'ok', windows: parse(r.json) };
}
module.exports = { id: 'kimi', label: 'Kimi Code', fetch: fetchQuota, parse, authPath };
