'use strict';

const fs = require('node:fs');
const path = require('node:path');

class DoctorError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function rootFrom(options = {}) { return path.resolve(options.house || process.env.SAMEROOF_ROOT || process.cwd()); }

function queuedCandidates(root, cutoff) {
  const file = path.join(root, 'state', 'house.db');
  if (!fs.existsSync(file)) throw new DoctorError('DOCTOR-DB-MISSING', '找不到 state/house.db，客厅可能还没启动过。');
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { throw new DoctorError('DOCTOR-SQLITE-UNAVAILABLE', '当前 Node 不带 node:sqlite，doctor 无法只读检查客厅数据库。'); }
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare("SELECT message_id,resident_id,status,ts FROM deliveries WHERE status='queued' AND ts<=? ORDER BY ts,resident_id").all(cutoff); }
  finally { db.close(); }
}

function heardPairs(root, wanted) {
  const found = new Set(); const badLines = [];
  const dir = path.join(root, 'state', 'runs');
  let files = []; try { files = fs.readdirSync(dir).filter(x => x.endsWith('.jsonl')); } catch { return { found, badLines }; }
  for (const name of files) {
    const fallbackResident = name.slice(0, -'.jsonl'.length);
    const lines = fs.readFileSync(path.join(dir, name), 'utf8').split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      let run; try { run = JSON.parse(lines[index]); } catch { badLines.push({ file: path.join('state', 'runs', name), line: index + 1 }); continue; }
      const resident = run.resident_id || fallbackResident;
      for (const message of Array.isArray(run.heard) ? run.heard : []) {
        if (!message || typeof message.id !== 'string') continue;
        const key = resident + '\0' + message.id;
        if (wanted.has(key)) found.add(key);
      }
    }
  }
  return { found, badLines };
}

function inspectLostMessages(options = {}, clock = Date.now()) {
  const root = rootFrom(options);
  const minutes = Number(options['queued-minutes'] ?? options.minutes ?? 10);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 30 * 24 * 60) throw new DoctorError('DOCTOR-THRESHOLD-INVALID', '--queued-minutes 必须是 0 到 43200 之间的数字。');
  const cutoff = new Date(clock - minutes * 60000).toISOString();
  const queued = queuedCandidates(root, cutoff);
  const wanted = new Set(queued.map(x => x.resident_id + '\0' + x.message_id));
  const { found, badLines } = heardPairs(root, wanted);
  const suspects = queued.filter(x => !found.has(x.resident_id + '\0' + x.message_id)).map(x => ({ ...x, queued_minutes: Math.max(0, Math.floor((clock - Date.parse(x.ts)) / 60000)) }));
  return { ok: suspects.length === 0, threshold_minutes: minutes, cutoff, queued_checked: queued.length, suspects, bad_run_lines: badLines };
}

// RFC 2026-09-15-gateway-allow §2.7: policy-allowed / rate-limited counts per resident for the last N days, from the gateway audit.
// Read-only; opens the gateway DB directly (same host). Silently absent if the DB isn't reachable (different user / not deployed).
function inspectPolicyAllow(options = {}, clock = Date.now()) {
  const root = rootFrom(options);
  const dbPath = options.gatewayDb || process.env.SAMEROOF_GATEWAY_DB || path.join(root, 'state', 'gateway.db');
  const days = Number(options.days || 1);
  const out = { db: dbPath, available: false, days, per_resident: {} };
  let Database; try { Database = require('better-sqlite3'); } catch { return out; }
  if (!fs.existsSync(dbPath)) return out;
  let db; try { db = new Database(dbPath, { readonly: true, fileMustExist: true }); } catch { return out; }
  try {
    const since = new Date(clock - days * 86400000).toISOString();
    const rows = db.prepare("SELECT event, resident_id, action, details_json FROM audit WHERE ts>=? AND event IN ('decided','rate_limited','output_read')").all(since);
    for (const r of rows) {
      let det = {}; try { det = JSON.parse(r.details_json || '{}'); } catch {}
      const rid = r.resident_id || '(none)';
      const p = out.per_resident[rid] = out.per_resident[rid] || { policy_allowed: 0, rate_limited: 0, output_reads: 0, actions: {} };
      if (r.event === 'decided' && det.decision_source === 'policy_allow') { p.policy_allowed++; p.actions[r.action] = (p.actions[r.action] || 0) + 1; }
      else if (r.event === 'rate_limited') p.rate_limited++;
      else if (r.event === 'output_read') p.output_reads++;
    }
    out.available = true;
  } finally { try { db.close(); } catch {} }
  return out;
}

function runDoctor(options = {}, io = console) {
  const report = inspectLostMessages(options);
  report.policy_allow = inspectPolicyAllow(options);
  if (options.json) io.log(JSON.stringify(report, null, 2));
  else {
    if (!report.suspects.length) io.log(`✓ 丢消息检查通过：没有排队超过 ${report.threshold_minutes} 分钟且从未进入目标住户 heard 的投递。`);
    else {
      io.log(`✗ 发现 ${report.suspects.length} 条疑似丢消息（排队超过 ${report.threshold_minutes} 分钟，目标住户的 run.heard 从未出现）：`);
      for (const item of report.suspects) io.log(`  ${item.resident_id}  ${item.message_id}  ${item.queued_minutes} 分钟`);
    }
    if (report.bad_run_lines.length) io.log(`! ${report.bad_run_lines.length} 行 run JSON 损坏，结果可能不完整。`);
    const pa = report.policy_allow;
    if (pa.available) {
      const ids = Object.keys(pa.per_resident);
      if (!ids.length) io.log(`· 最近 ${pa.days} 天没有政策放行的网关动作。`);
      else { io.log(`· 最近 ${pa.days} 天政策放行（不经人点击）的网关动作：`); for (const id of ids) { const p = pa.per_resident[id]; io.log(`  ${id}  放行 ${p.policy_allowed}${Object.keys(p.actions).length ? '（' + Object.entries(p.actions).map(([a, n]) => a + '×' + n).join('，') + '）' : ''}  限流拒绝 ${p.rate_limited}  输出读取 ${p.output_reads}`); } }
    }
  }
  return report;
}

module.exports = { DoctorError, inspectLostMessages, inspectPolicyAllow, runDoctor, heardPairs };
