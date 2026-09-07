/**
 * Same Roof B1 metrics
 * JSONL runs + sqlite3 CLI for house.db
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));


function parseArgs(argv) {
  const out = { root: process.env.SAMEROOF_ROOT || null, before: null, after: null, queuedMinutes: 10 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], next = argv[i + 1];
    if (a === '--root' && next) { out.root = next; i++; }
    else if (a === '--before' && next) { out.before = next; i++; }
    else if (a === '--after' && next) { out.after = next; i++; }
    else if (a === '--queued-minutes' && next) { out.queuedMinutes = Number(next); i++; }
    else if (a === '--help' || a === '-h') { out.help = true; }
  }
  return out;
}

function detectRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.SAMEROOF_ROOT) return path.resolve(process.env.SAMEROOF_ROOT);
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'house.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (fs.existsSync('/root/sameroof/house.yaml')) return '/root/sameroof';
  return process.cwd();
}

function parseTs(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
function inWindow(tsMs, afterMs, beforeMs) {
  if (tsMs == null) return false;
  if (afterMs != null && tsMs < afterMs) return false;
  if (beforeMs != null && tsMs >= beforeMs) return false;
  return true;
}
function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}
function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function median(arr) {
  if (!arr.length) return null;
  return percentile([...arr].sort((a, b) => a - b), 0.5);
}
function fmtSec(v) {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  return v.toFixed(2) + 's';
}
function fmtNum(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  return Number(v).toFixed(digits);
}

function sqliteJson(dbPath, sql) {
  const r = spawnSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || '').trim() || ('sqlite3 exit ' + r.status));
  const raw = (r.stdout || '').trim();
  if (!raw) return [];
  return JSON.parse(raw);
}

async function loadRuns(runsDir) {
  const files = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith('.jsonl')).sort() : [];
  const runs = [];
  for (const file of files) {
    const full = path.join(runsDir, file);
    const rl = readline.createInterface({ input: fs.createReadStream(full, { encoding: 'utf8' }), crlfDelay: Infinity });
    let lineNo = 0;
    for await (const line of rl) {
      lineNo++;
      const t = line.trim();
      if (!t) continue;
      try {
        const row = JSON.parse(t);
        row.__file = file;
        row.__line = lineNo;
        runs.push(row);
      } catch { /* skip */ }
    }
  }
  return runs;
}

function isWake(run) {
  const reason = String(run.reason || '');
  if (reason.includes('叫我')) return true;
  if (run.lane === 'human') return true;
  return false;
}
function bump(map, key) {
  const k = key == null || key === '' ? '(null)' : String(key);
  map[k] = (map[k] || 0) + 1;
}
function topN(map, n = 15) {
  return Object.entries(map).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k, v]) => ({ key: k, count: v }));
}

function compute(runs, msgById, deliveries, opts) {
  const afterMs = opts.after ? parseTs(opts.after) : null;
  const beforeMs = opts.before ? parseTs(opts.before) : null;
  const queuedMs = (opts.queuedMinutes ?? 10) * 60 * 1000;
  const nowMs = Date.now();
  const filtered = runs.filter((r) => inWindow(parseTs(r.ts), afterMs, beforeMs));
  const statusHist = {}, laneHist = {}, reasonHist = {}, heardByStatus = {};
  const heardAll = [], interrupted = [], deferred = [], wakeLatencies = [], modelMs = [];
  const heardByResidentAll = new Map();
  for (const r of runs) {
    const rid = r.resident_id;
    if (!rid) continue;
    if (!heardByResidentAll.has(rid)) heardByResidentAll.set(rid, new Set());
    const set = heardByResidentAll.get(rid);
    for (const h of r.heard || []) { if (h && h.id) set.add(h.id); }
  }

  for (const r of filtered) {
    bump(statusHist, r.status);
    bump(laneHist, r.lane);
    bump(reasonHist, r.reason || '(empty)');
    const heardLen = Array.isArray(r.heard) ? r.heard.length : 0;
    heardAll.push(heardLen);
    const st = r.status == null ? '(null)' : String(r.status);
    if (!heardByStatus[st]) heardByStatus[st] = [];
    heardByStatus[st].push(heardLen);
    if (r.status === 'interrupted') interrupted.push(r);
    if (r.status === 'deferred') deferred.push(r);
    if (typeof r.ms === 'number' && Number.isFinite(r.ms)) modelMs.push(r.ms);
    if (isWake(r)) {
      const mentioned = (r.heard || []).filter((h) => h && h.id && h.mentioned === true);
      let triggerId = null, triggerTs = null;
      for (const h of mentioned) {
        const m = msgById.get(h.id);
        const mts = m ? parseTs(m.ts) : null;
        if (mts == null) continue;
        if (triggerTs == null || mts > triggerTs) { triggerTs = mts; triggerId = h.id; }
      }
      if (triggerId == null) {
        for (const h of r.heard || []) {
          if (!h || !h.id) continue;
          const m = msgById.get(h.id);
          const mts = m ? parseTs(m.ts) : null;
          if (mts == null) continue;
          if (triggerTs == null || mts > triggerTs) { triggerTs = mts; triggerId = h.id; }
        }
      }
      const runTs = parseTs(r.ts);
      if (triggerTs != null && runTs != null && runTs >= triggerTs) {
        wakeLatencies.push({ seconds: (runTs - triggerTs) / 1000, run_ts: r.ts, message_id: triggerId, resident_id: r.resident_id, status: r.status, lane: r.lane, model_ms: r.ms });
      }
    }
  }

  const dropped = [];
  for (const d of deliveries) {
    if (d.status !== 'queued') continue;
    const dts = parseTs(d.ts);
    if (dts == null) continue;
    if (!inWindow(dts, afterMs, beforeMs)) continue;
    if (nowMs - dts < queuedMs) continue;
    const set = heardByResidentAll.get(d.resident_id) || new Set();
    if (!set.has(d.message_id)) dropped.push(d);
  }
  const wakeSecs = wakeLatencies.map((x) => x.seconds).sort((a, b) => a - b);
  const modelSecs = modelMs.map((ms) => ms / 1000).sort((a, b) => a - b);
  const heardByStatusOut = {};
  for (const [k, arr] of Object.entries(heardByStatus)) {
    heardByStatusOut[k] = { n: arr.length, mean: mean(arr), median: median(arr) };
  }
  return {
    window: { after: opts.after || null, before: opts.before || null, queued_minutes: opts.queuedMinutes },
    runs_total_corpus: runs.length,
    runs_in_window: filtered.length,
    status_histogram: statusHist,
    lane_histogram: laneHist,
    reason_tops: topN(reasonHist, 20),
    heard_length: { overall: { n: heardAll.length, mean: mean(heardAll), median: median(heardAll) }, by_status: heardByStatusOut },
    wake_to_response: {
      definition: 'wake = reason contains 叫我 OR lane===human; trigger = latest mentioned heard[].id by messages.ts (fallback: latest heard id); latency = run.ts - message.ts',
      n: wakeSecs.length, p50_s: percentile(wakeSecs, 0.5), p90_s: percentile(wakeSecs, 0.9), mean_s: mean(wakeSecs),
      samples_head: wakeLatencies.slice(0, 5),
    },
    model_latency_ms_field: {
      label: 'run.ms (model/runtime duration, separate from wake→response)',
      n: modelSecs.length, p50_s: percentile(modelSecs, 0.5), p90_s: percentile(modelSecs, 0.9), mean_s: mean(modelSecs),
    },
    dropped_messages: {
      definition: 'deliveries status=queued older than N minutes whose message_id never appears in any run heard[] for that resident_id',
      count: dropped.length, samples: dropped.slice(0, 10),
    },
    interrupted: { interrupted: interrupted.length, deferred: deferred.length },
  };
}

function renderText(report) {
  const lines = [];
  lines.push('=== Same Roof metrics ===');
  lines.push('root: ' + report.root);
  lines.push('db: ' + report.db);
  lines.push('runs_dir: ' + report.runs_dir);
  lines.push('window after=' + (report.window.after || '-') + ' before=' + (report.window.before || '-') + ' queued_minutes=' + report.window.queued_minutes);
  lines.push('runs corpus=' + report.runs_total_corpus + ' in_window=' + report.runs_in_window);
  lines.push('');
  lines.push('-- status histogram --');
  for (const [k, v] of Object.entries(report.status_histogram).sort((a, b) => b[1] - a[1])) lines.push('  ' + k + ': ' + v);
  lines.push('-- lane histogram --');
  for (const [k, v] of Object.entries(report.lane_histogram).sort((a, b) => b[1] - a[1])) lines.push('  ' + k + ': ' + v);
  lines.push('-- reason tops --');
  for (const row of report.reason_tops) lines.push('  ' + row.count + 'x ' + row.key);
  lines.push('');
  lines.push('-- heard.length --');
  lines.push('  overall n=' + report.heard_length.overall.n + ' mean=' + fmtNum(report.heard_length.overall.mean) + ' median=' + fmtNum(report.heard_length.overall.median));
  for (const [k, v] of Object.entries(report.heard_length.by_status).sort()) {
    lines.push('  status=' + k + ': n=' + v.n + ' mean=' + fmtNum(v.mean) + ' median=' + fmtNum(v.median));
  }
  lines.push('');
  lines.push('-- wake to response --');
  const w = report.wake_to_response;
  lines.push('  n=' + w.n + ' p50=' + fmtSec(w.p50_s) + ' p90=' + fmtSec(w.p90_s) + ' mean=' + fmtSec(w.mean_s));
  lines.push('  (' + w.definition + ')');
  lines.push('-- model latency (run.ms) --');
  const m = report.model_latency_ms_field;
  lines.push('  n=' + m.n + ' p50=' + fmtSec(m.p50_s) + ' p90=' + fmtSec(m.p90_s) + ' mean=' + fmtSec(m.mean_s));
  lines.push('');
  lines.push('-- dropped --');
  lines.push('  count=' + report.dropped_messages.count);
  lines.push('  (' + report.dropped_messages.definition + ')');
  for (const s of report.dropped_messages.samples) lines.push('  - ' + s.ts + ' ' + s.resident_id + ' ' + s.message_id);
  lines.push('');
  lines.push('-- interrupted --');
  lines.push('  interrupted=' + report.interrupted.interrupted + ' deferred=' + report.interrupted.deferred);
  lines.push('');
  return lines.join(String.fromCharCode(10));
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: node scripts/metrics/summary.mjs [--root /root/sameroof] [--before ISO] [--after ISO] [--queued-minutes 10]');
    process.exit(0);
  }
  const root = detectRoot(args.root);
  const runsDir = path.join(root, 'state', 'runs');
  const dbPath = path.join(root, 'state', 'house.db');
  if (!fs.existsSync(dbPath)) { console.error('house.db not found: ' + dbPath); process.exit(2); }
  if (!fs.existsSync(runsDir)) { console.error('runs dir not found: ' + runsDir); process.exit(2); }
  const runs = await loadRuns(runsDir);
  const messages = sqliteJson(dbPath, 'SELECT id, ts FROM messages;');
  const deliveries = sqliteJson(dbPath, 'SELECT message_id, resident_id, status, ts FROM deliveries;');
  const msgById = new Map(messages.map((m) => [m.id, m]));
  const stats = compute(runs, msgById, deliveries, args);
  const report = { generated_at: new Date().toISOString(), root, db: dbPath, runs_dir: runsDir, ...stats };
  console.log(renderText(report));
  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'latest.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('JSON written: ' + outPath);
}

main().catch((err) => { console.error(err); process.exit(1); });
