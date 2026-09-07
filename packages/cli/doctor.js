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

function runDoctor(options = {}, io = console) {
  const report = inspectLostMessages(options);
  if (options.json) io.log(JSON.stringify(report, null, 2));
  else {
    if (!report.suspects.length) io.log(`✓ 丢消息检查通过：没有排队超过 ${report.threshold_minutes} 分钟且从未进入目标住户 heard 的投递。`);
    else {
      io.log(`✗ 发现 ${report.suspects.length} 条疑似丢消息（排队超过 ${report.threshold_minutes} 分钟，目标住户的 run.heard 从未出现）：`);
      for (const item of report.suspects) io.log(`  ${item.resident_id}  ${item.message_id}  ${item.queued_minutes} 分钟`);
    }
    if (report.bad_run_lines.length) io.log(`! ${report.bad_run_lines.length} 行 run JSON 损坏，结果可能不完整。`);
  }
  return report;
}

module.exports = { DoctorError, inspectLostMessages, runDoctor, heardPairs };
