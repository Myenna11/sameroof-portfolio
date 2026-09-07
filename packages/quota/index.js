// 同屋 · 配额气象台：住户的 provider → 各家适配器并发取数 → 统一 schema。单家失败不拖垮整体；上次拿到的好数据留着标 stale。
// 卡片：{ provider, label, residents:[名], status:'ok'|'error', message?, windows:[{label, usedPercent, resetAt?, resetHint?, detail?}], fetchedAt, stale?, staleSince? }
'use strict';
const fs = require('fs');
const path = require('path');
const PROVIDERS = { claude: require('./providers/claude'), codex: require('./providers/codex'), kimi: require('./providers/kimi'), glm: require('./providers/glm'), deepseek: require('./providers/deepseek') };
const PROVIDER_OF = { 'claude-code': 'claude', anthropic: 'claude', claude: 'claude', 'openai-codex': 'codex', codex: 'codex', openai: 'codex', 'kimi-coding': 'kimi', kimi: 'kimi', moonshot: 'kimi', zhipu: 'glm', glm: 'glm', zai: 'glm', 'z.ai': 'glm', deepseek: 'deepseek' };
const STALE_AFTER_MS = 20 * 60 * 1000;       // 上次好数据超过 20 分钟就算过期（还是给，但明确标）

function providerOf(resident) { const p = resident && resident.model && resident.model.provider; return p ? (PROVIDER_OF[String(p).toLowerCase()] || null) : null; }
function groupResidents(residents) {
  const groups = {};
  for (const r of residents || []) { if (r.species === 'human') continue; const id = providerOf(r); if (!id) continue; (groups[id] = groups[id] || []).push(r); }
  return groups;
}
const withTimeout = (p, ms) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`超过 ${ms / 1000}s 没回`)), ms); })]).finally(() => clearTimeout(t)); };
// 房子时区里"今天 00:00"的 ISO（给 broker 账本算今日用量）
function dayStartIso(tz, now = new Date()) {
  try { const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); const local = new Date(`${f}T00:00:00Z`); const off = new Date(now.toLocaleString('en-US', { timeZone: tz })) - new Date(now.toLocaleString('en-US', { timeZone: 'UTC' })); return new Date(local.getTime() - off).toISOString(); }
  catch { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); }
}
async function fetchAll(ctx = {}) {
  const groups = groupResidents(ctx.residents);
  const timeoutMs = ctx.timeoutMs || 15000;
  const providers = ctx.providers || PROVIDERS;
  return Promise.all(Object.entries(groups).map(async ([id, rs]) => {
    const p = providers[id]; const base = { provider: id, label: p ? p.label : id, residents: rs.map(r => r.name), fetchedAt: new Date().toISOString() };
    if (!p) return { ...base, status: 'error', message: `还没写 ${id} 的适配器`, windows: [] };
    try { const card = await withTimeout(p.fetch({ ...ctx, residents: rs, timeoutMs }), timeoutMs + 1000); return { ...base, status: card.status || 'ok', windows: card.windows || [], ...(card.message ? { message: card.message } : {}) }; }
    catch (e) { return { ...base, status: 'error', code: e.code || 'QUOTA-UNAVAILABLE', message: String(e && e.message || e), windows: [] }; }
  }));
}
// 带"上次好数据"缓存的一次快照：错的卡片附上 lastOk 的窗口并标 stale
async function snapshot(ctx = {}) {
  const cachePath = ctx.cachePath || null;
  let cache = {}; if (cachePath) { try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')) || {}; } catch {} }
  const cards = await fetchAll({ ...ctx, dayStartIso: ctx.dayStartIso || dayStartIso(ctx.tz || 'UTC') });
  const now = Date.now();
  for (const c of cards) {
    if (c.status === 'ok') { cache[c.provider] = { windows: c.windows, message: c.message, fetchedAt: c.fetchedAt }; continue; }
    const last = cache[c.provider];
    if (last && last.windows && last.windows.length) { c.windows = last.windows; c.stale = true; c.staleSince = last.fetchedAt; c.staleExpired = now - Date.parse(last.fetchedAt) > STALE_AFTER_MS; }
  }
  if (cachePath) { try { fs.mkdirSync(path.dirname(cachePath), { recursive: true }); fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2)); } catch {} }
  return { fetched_at: new Date().toISOString(), providers: cards };
}
module.exports = { PROVIDERS, PROVIDER_OF, providerOf, groupResidents, fetchAll, snapshot, dayStartIso, STALE_AFTER_MS };
