// GLM（智谱）：key 在 broker 账本里，只读拿出来查 coding plan 额度（/api/monitor/usage/quota/limit，参考 token-usage 的 zaiGLMQuery）。
// 这家的坑：按量付费的 key 没有 coding plan，接口回 {"code":500,"msg":"当前用户不存在coding plan"}（本机真拿到的），智谱也没公开余额接口——
// 这种情况不伪造，改用 broker 本地账本：住户 token 预算用了几成、今天烧了多少。这是真数据，只是不是智谱那边的。
'use strict';
const { getJson, num, window, toIso, QuotaError } = require('../lib');
const store = require('../broker-store');
const TYPE_LABEL = { TOKENS_LIMIT: 'Coding Plan 额度窗（tokens）', CREDIT_LIMIT: 'Coding Plan 月额度' };

function parsePlan(json) {
  if (!json || typeof json !== 'object') throw new QuotaError('quota/limit 响应不是对象');
  if (json.code !== 200 || json.success !== true) throw new QuotaError(String(json.msg || `code ${json.code}`), json.msg && /coding plan/i.test(json.msg) ? 'QUOTA-NO-PLAN' : 'QUOTA-REJECTED');
  const windows = [];
  for (const l of (json.data && Array.isArray(json.data.limits)) ? json.data.limits : []) {
    if (!l || !TYPE_LABEL[l.type]) continue;                               // TIME_LIMIT 这种没有百分比的窗口不出
    const w = window(TYPE_LABEL[l.type], l.percentage, { resetAt: l.nextResetTime ?? l.next_reset_time ?? l.resetTime }); if (w) windows.push(w);
  }
  if (!windows.length) throw new QuotaError('quota/limit 里没有带百分比的窗口');
  return windows;
}
// broker 预算 → 窗口：max_tokens / max_requests 有上限的才算得出百分比
function budgetWindows(rows, nameOf) {
  const windows = [];
  for (const r of rows) for (const t of r.tokens) {
    const who = nameOf(r.resident_id);
    const exp = toIso(t.expires_at);
    if (num(t.max_tokens)) { const w = window(`${who} · broker token 预算`, t.used_tokens / t.max_tokens * 100, { resetAt: exp, detail: `${t.used_tokens} / ${t.max_tokens} tokens` }); if (w) windows.push(w); }
    if (num(t.max_requests)) { const w = window(`${who} · broker 请求预算`, t.used_requests / t.max_requests * 100, { resetAt: exp, detail: `${t.used_requests} / ${t.max_requests} 次` }); if (w) windows.push(w); }
  }
  return windows;
}
async function fetchQuota(ctx = {}) {
  const env = ctx.env || process.env;
  const residents = ctx.residents || [];
  const alias = residents.map(r => r.model && r.model.auth && r.model.auth.credential).find(Boolean);
  const cred = store.credentialFor(env, 'zhipu', alias);
  if (!cred) throw new QuotaError('broker 里没有智谱的活跃凭证', 'QUOTA-NOT-CONFIGURED');
  const origin = new URL(cred.base_url).origin;
  const notes = [];
  let windows = [];
  try {
    const r = await getJson(`${origin}/api/monitor/usage/quota/limit`, { authorization: `Bearer ${cred.api_key}` }, ctx);
    if (r.status !== 200) throw new QuotaError(`${origin} 回了 ${r.status}：${r.text}`);
    windows = parsePlan(r.json); notes.push(`凭证 ${cred.alias}`);
  } catch (e) {
    if (e.code !== 'QUOTA-NO-PLAN') throw e;
    notes.push(`凭证 ${cred.alias} 是按量付费，没有 Coding Plan；智谱没公开余额接口，下面是 broker 本地账本`);
  }
  const rows = store.budgets(env, residents.map(r => r.id), ctx.dayStartIso || new Date(Date.now() - 86400000).toISOString());
  const nameOf = id => (residents.find(r => r.id === id) || {}).name || id;
  windows.push(...budgetWindows(rows, nameOf));
  for (const r of rows) notes.push(`${nameOf(r.resident_id)} 今日经 broker ${r.today.n} 次 · ${r.today.tokens} tokens`);
  if (!windows.length) throw new QuotaError(notes.join('；') + '；broker token 也没设上限，算不出百分比', 'QUOTA-NO-WINDOWS');
  return { status: 'ok', windows, message: notes.join('；') };
}
module.exports = { id: 'glm', label: 'GLM（智谱）', fetch: fetchQuota, parse: parsePlan, budgetWindows };
