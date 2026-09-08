// 同屋 · broker 只读报表（V2-LEDGER）：把账本按天 × 住户聚合给房子看，不暴露 request 明细、token_id、凭证。
// 鉴权跟 web-push 一样：一个只有房子能读的客户端 token 文件（<stateDir>/report-client.token），凭它调 /internal/report/daily。
// 这是控制面里"只读"的那一格：客厅不开 broker 的库（DECISIONS #11），broker 自己算好递出去。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { BrokerError } = require('./store');

function atomicWrite(file, value, mode = 0o600) {
  const temporary = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  try { fs.writeFileSync(temporary, value, { mode, flag: 'wx' }); fs.chmodSync(temporary, mode); fs.renameSync(temporary, file); fs.chmodSync(file, mode); }
  finally { try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {} }
}
const validTz = tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

class LedgerReport {
  constructor(options = {}) {
    this.store = options.store;
    this.stateDir = options.stateDir || (this.store && this.store.stateDir);
    this.clientTokenFile = path.join(this.stateDir, 'report-client.token');
  }
  initialize(rotate = false) {
    if (!rotate && fs.existsSync(this.clientTokenFile)) throw new BrokerError(409, 'REPORT-CREDENTIAL-EXISTS', '报表客户端凭证已存在；轮换必须显式加 --rotate。');
    const token = 'srr_' + crypto.randomBytes(32).toString('base64url');
    atomicWrite(this.clientTokenFile, token + '\n');
    return { file: this.clientTokenFile, created_at: new Date().toISOString(), rotated: rotate };
  }
  status() { return { configured: fs.existsSync(this.clientTokenFile), file: this.clientTokenFile }; }
  authorize(secret) {
    let token; try { token = fs.readFileSync(this.clientTokenFile, 'utf8').trim(); } catch { throw new BrokerError(503, 'REPORT-NOT-CONFIGURED', '报表客户端凭证尚未初始化（sameroof-broker report init）。'); }
    if (token.length < 32) throw new BrokerError(500, 'REPORT-CREDENTIAL-INVALID', '报表客户端凭证文件损坏。');
    if (typeof secret !== 'string') throw new BrokerError(401, 'REPORT-CLIENT-INVALID', '报表调用凭证无效。');
    const a = Buffer.from(token), b = Buffer.from(secret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new BrokerError(401, 'REPORT-CLIENT-INVALID', '报表调用凭证无效。');
  }
  // 按天（tz 由调用方给，房子的账务时区）× 住户聚合。每格：requests / ok / errors / tokens / cached / cache_creation / estimated / latency_avg_ms；
  // 另给每住户 by_model（provider/model → requests/tokens）。天列表连续、含空天，方便直接画图。
  daily({ days = 7, tz = 'UTC', now = Date.now() } = {}) {
    days = Math.max(1, Math.min(90, Number(days) || 7));
    if (!validTz(tz)) throw new BrokerError(400, 'REPORT-TZ-INVALID', 'tz 不是合法时区。');
    const dayOf = ts => { try { return new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(new Date(ts)); } catch { return null; } };
    const today = dayOf(now);
    const dayList = []; for (let i = days - 1; i >= 0; i--) dayList.push(new Date(Date.parse(today + 'T12:00:00Z') - i * 86400000).toISOString().slice(0, 10));
    const sinceIso = new Date(Date.parse(dayList[0] + 'T00:00:00Z') - 14 * 3600000).toISOString();   // 往前多取 14h 盖住任何时区偏移，再按 tz 精确归天
    const rows = this.store.db.prepare('SELECT ts,resident_id,provider,model,status,actual_tokens,estimated,cached_tokens,cache_creation_tokens,latency_ms FROM ledger WHERE ts >= ? ORDER BY ts').all(sinceIso);
    const blank = d => ({ day: d, requests: 0, ok: 0, errors: 0, tokens: 0, cached: 0, cache_creation: 0, estimated: 0, latency_sum: 0, latency_n: 0 });
    const res = new Map();
    for (const r of rows) {
      const d = dayOf(r.ts); if (!d || d < dayList[0] || d > dayList[dayList.length - 1]) continue;
      if (!res.has(r.resident_id)) res.set(r.resident_id, { resident_id: r.resident_id, byDay: Object.fromEntries(dayList.map(x => [x, blank(x)])), by_model: {} });
      const R = res.get(r.resident_id); const b = R.byDay[d];
      const ok = r.status === 'complete' || r.status === 'mock_complete';
      b.requests++; if (ok) b.ok++; else b.errors++;
      b.tokens += Number(r.actual_tokens) || 0; b.cached += Number(r.cached_tokens) || 0; b.cache_creation += Number(r.cache_creation_tokens) || 0; if (r.estimated) b.estimated++;
      if (Number.isFinite(Number(r.latency_ms))) { b.latency_sum += Number(r.latency_ms); b.latency_n++; }
      const mk = `${r.provider}/${r.model || '?'}`; const m = R.by_model[mk] || (R.by_model[mk] = { provider: r.provider, model: r.model || null, requests: 0, tokens: 0, cached: 0 });
      m.requests++; m.tokens += Number(r.actual_tokens) || 0; m.cached += Number(r.cached_tokens) || 0;
    }
    const fin = b => ({ day: b.day, requests: b.requests, ok: b.ok, errors: b.errors, tokens: b.tokens, cached: b.cached, cache_creation: b.cache_creation, estimated: b.estimated, latency_avg_ms: b.latency_n ? Math.round(b.latency_sum / b.latency_n) : null });
    const residents = [...res.values()].map(R => {
      const daysOut = dayList.map(d => fin(R.byDay[d]));
      const total = daysOut.reduce((a, b) => ({ requests: a.requests + b.requests, ok: a.ok + b.ok, errors: a.errors + b.errors, tokens: a.tokens + b.tokens, cached: a.cached + b.cached, cache_creation: a.cache_creation + b.cache_creation, estimated: a.estimated + b.estimated }), { requests: 0, ok: 0, errors: 0, tokens: 0, cached: 0, cache_creation: 0, estimated: 0 });
      return { resident_id: R.resident_id, days: daysOut, total, by_model: Object.values(R.by_model) };
    }).sort((a, b) => b.total.tokens - a.total.tokens);
    return { days: dayList, timezone: tz, generated_at: new Date(now).toISOString(), residents };
  }
}
module.exports = { LedgerReport };
