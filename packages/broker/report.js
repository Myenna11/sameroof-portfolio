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

// ---- V2-DOCTOR 前缀漂移：同一住户连续两次上游请求的 wire body 做公共前缀比对，报第几个字符开始分叉 ----
// 健康的累积会话：新 body = 旧 body 去掉结尾的 "}]" 等几个字符 + 追加的 assistant/user。分叉点 ≥ 旧 body 长度 − TAIL 就算稳。
// 分叉在更前面 = 前缀被改了（system 变了、messages 被重排/压缩、参数顺序变了…），缓存从那一字节起全废。只在内存里留每住户最近 keep 条。
// 稳的定义：分叉点 ≥ 上一条 body 里 messages 数组收尾的位置（新 body 只在那之后变：'}]'→'},{'）。
// 用 JSON.stringify(body.messages) 在 wire body 里定位数组，比固定尾巴容差准（短 body 时固定容差会吞掉 system 里的真分叉）。
const DRIFT_TAIL = 160;   // 只在定位不到 messages 时兜底
class PrefixDoctor {
  constructor({ keep = 50, maxBody = 2 * 1024 * 1024 } = {}) { this.keep = keep; this.maxBody = maxBody; this.last = new Map(); this.log = new Map(); }
  observe({ residentId, requestId, wireBody, body, model }) {
    const now = wireBody.length > this.maxBody ? wireBody.slice(0, this.maxBody) : wireBody;
    let msgEnd = null; try { const M = JSON.stringify(body && body.messages); const k = M ? now.indexOf(M) : -1; if (k >= 0) msgEnd = k + M.length - 1; } catch {}
    // 血统 = 住户 + system 内容摘要（permafrost 的 lineage）：换了 system（新班、睡前便条、压缩摘要）是另一条血统，不跟上一条比，报"新血统"
    let lineage = residentId; try { const sys = body && Array.isArray(body.messages) && body.messages[0] && body.messages[0].role === 'system' ? String(body.messages[0].content) : ''; lineage = residentId + ':' + require('crypto').createHash('sha256').update(sys).digest('hex').slice(0, 12); } catch {}
    let prev = this.last.get(lineage); let midShift = false;
    const nMsgs = body && Array.isArray(body.messages) ? body.messages.length : 0;
    const lastAny = this.last.get(residentId + ':any');
    if (!prev && lastAny && nMsgs >= 4) { prev = lastAny; midShift = true; }   // 新血统但已经堆了一段对话：system 中途被改（惦记本/小本进了 system 又变了）——前缀全废，要报
    let rec = { ts: new Date().toISOString(), request_id: requestId, model, lineage: lineage.slice(residentId.length + 1), body_len: wireBody.length, prev_request_id: null, prev_len: null, drift_at: null, stable: null, note: prev ? '' : (lastAny ? '新血统（system 变了，新班/便条），无可比' : '首条，无可比') };
    if (prev) {
      let i = 0; const n = Math.min(prev.body.length, now.length); while (i < n && prev.body.charCodeAt(i) === now.charCodeAt(i)) i++;
      const need = prev.msgEnd != null ? prev.msgEnd - 1 : prev.body.length - DRIFT_TAIL;
      const stable = i >= need;
      rec = { ...rec, prev_request_id: prev.request_id, prev_len: prev.body.length, prev_messages_end: prev.msgEnd, drift_at: i, stable,
        note: stable ? '前缀稳，只在结尾追加' : (midShift ? 'system 中途变了（前缀全废）' : prev.model !== model ? '换了模型' : i < 64 ? '开头就不一样（model/键序？）' : '中段分叉：前缀被改了'),
        ...(stable ? {} : { was: prev.body.slice(Math.max(0, i - 60), i + 60), now: now.slice(Math.max(0, i - 60), i + 60) }) };
    }
    const entry = { body: now, request_id: requestId, model, msgEnd }; this.last.set(lineage, entry); this.last.set(residentId + ':any', entry);
    const list = this.log.get(residentId) || []; list.push(rec); if (list.length > this.keep) list.splice(0, list.length - this.keep); this.log.set(residentId, list);
    return rec;
  }
  report({ resident = null, limit = 20 } = {}) {
    const ids = resident ? [resident] : [...this.log.keys()];
    return { generated_at: new Date().toISOString(), residents: ids.map(id => { const rows = (this.log.get(id) || []).slice(-Math.max(1, Math.min(200, Number(limit) || 20)));
      const cmp = rows.filter(r => r.stable !== null); return { resident_id: id, observed: rows.length, compared: cmp.length, unstable: cmp.filter(r => !r.stable).length, rows }; }) };
  }
}
module.exports.PrefixDoctor = PrefixDoctor;
