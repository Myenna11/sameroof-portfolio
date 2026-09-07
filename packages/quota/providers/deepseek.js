// DeepSeek（按量）：key 在 broker 账本里，查 /user/balance（参考 token-usage 的 deepseekQuery）。余额不是百分比，不伪造窗口，只给一行文案。
'use strict';
const { getJson, QuotaError } = require('../lib');
const store = require('../broker-store');
function parse(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.balance_infos) || !json.balance_infos.length) throw new QuotaError('balance 响应里没有 balance_infos');
  const b = json.balance_infos[0];
  return { available: json.is_available !== false, text: `余额 ${b.total_balance} ${b.currency}${Number(b.granted_balance) > 0 ? `（含赠送 ${b.granted_balance}）` : ''}` };
}
async function fetchQuota(ctx = {}) {
  const env = ctx.env || process.env;
  const cred = store.credentialFor(env, 'deepseek');
  if (!cred) throw new QuotaError('broker 里没有 DeepSeek 的活跃凭证', 'QUOTA-NOT-CONFIGURED');
  const r = await getJson('https://api.deepseek.com/user/balance', { authorization: `Bearer ${cred.api_key}` }, ctx);
  if (r.status === 401) throw new QuotaError('DeepSeek key 被拒（401）', 'QUOTA-EXPIRED');
  if (r.status !== 200) throw new QuotaError(`api.deepseek.com 回了 ${r.status}：${r.text}`);
  const p = parse(r.json);
  return { status: 'ok', windows: [], message: `${p.text}${p.available ? '' : '（账户不可用）'} · 按量付费，没有额度窗` };
}
module.exports = { id: 'deepseek', label: 'DeepSeek', fetch: fetchQuota, parse };
