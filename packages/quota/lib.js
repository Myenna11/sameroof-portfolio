// 同屋 · 配额 · 公共件：带超时的 GET JSON、窗口归一化、时间解析。凭据只在这一层往请求头里放，永远不进返回值。
'use strict';
const fs = require('fs');
const UA = 'sameroof-quota/0.1 (+https://github.com/sameroof)';

async function getJson(url, headers = {}, { timeoutMs = 15000 } = {}) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA, ...headers }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: text.slice(0, 400) };
}
const readJsonFile = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const num = v => { const n = typeof v === 'string' ? Number(v) : v; return Number.isFinite(n) ? n : null; };
const pct = v => { const n = num(v); return n == null ? null : Math.max(0, Math.min(100, n)); };
// 各家的重置时间五花八门：ISO 串、epoch 秒、epoch 毫秒；统一成 ISO，认不出来就 null
function toIso(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) { const n = Number(v); if (!n) return null; return new Date(n < 1e12 ? n * 1000 : n).toISOString(); }
  const t = Date.parse(String(v)); return Number.isNaN(t) ? null : new Date(t).toISOString();
}
// usedPercent 是唯一必需读数：没有就不出这个窗口（不伪造）
function window(label, usedPercent, extra = {}) {
  const p = pct(usedPercent); if (p == null) return null;
  const w = { label, usedPercent: Math.round(p * 10) / 10 };
  if (extra.resetAt) { const iso = toIso(extra.resetAt); if (iso) w.resetAt = iso; }
  if (!w.resetAt && extra.resetHint) w.resetHint = String(extra.resetHint);
  if (extra.detail) w.detail = String(extra.detail);
  return w;
}
const secondsLabel = s => { const n = num(s); if (n == null) return null; if (n % 86400 === 0) return `${n / 86400} 天窗`; if (n % 3600 === 0) return `${n / 3600} 小时窗`; if (n % 60 === 0) return `${n / 60} 分钟窗`; return `${n} 秒窗`; };
class QuotaError extends Error { constructor(message, code = 'QUOTA-UNAVAILABLE') { super(message); this.code = code; } }
module.exports = { getJson, readJsonFile, num, pct, toIso, window, secondsLabel, QuotaError, UA };
